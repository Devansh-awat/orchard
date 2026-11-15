package commands

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/hackclub/orchard/orchardctl/internal/cli"
	"gopkg.in/yaml.v3"
)

type barmanCluster struct {
	dir     string
	calls   string
	applied string
}

func fakeBarmanKubectl(t *testing.T) barmanCluster {
	t.Helper()
	dir := t.TempDir()
	k := barmanCluster{dir: dir, calls: filepath.Join(dir, "calls"), applied: filepath.Join(dir, "applied")}
	script := `#!/bin/sh
printf '%s\n' "$*" >> "` + k.calls + `"
case "$*" in
  *"get deploy plugin-barman-cloud"*) [ -f "` + dir + `/deploy" ] || exit 1; echo deployment.apps/plugin-barman-cloud ;;
  *certificates.cert-manager.io*) [ -f "` + dir + `/cert-manager" ] || exit 1; echo certificate.cert-manager.io/barman-cloud-server ;;
  *"get secret barman-cloud-server-tls"*) cat "` + dir + `/barman-cloud-server-tls.json" 2>/dev/null || exit 1 ;;
  *"get secret barman-cloud-client-tls"*) cat "` + dir + `/barman-cloud-client-tls.json" 2>/dev/null || exit 1 ;;
  *"apply -f -"*) cat > "` + k.applied + `" ;;
esac
exit 0
`
	if err := os.WriteFile(filepath.Join(dir, "kubectl"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return k
}

func (k barmanCluster) touch(t *testing.T, name string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(k.dir, name), nil, 0o600); err != nil {
		t.Fatal(err)
	}
}

func (k barmanCluster) store(t *testing.T, b barmanBundle) {
	t.Helper()
	for name, pair := range map[string]barmanKeyPair{barmanServerSecret: b.server, barmanClientSecret: b.client} {
		raw, err := json.Marshal(map[string]any{"data": map[string]string{
			"tls.crt": base64.StdEncoding.EncodeToString(pair.cert),
			"tls.key": base64.StdEncoding.EncodeToString(pair.key),
			"ca.crt":  base64.StdEncoding.EncodeToString(b.ca),
		}})
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(k.dir, name+".json"), raw, 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

func (k barmanCluster) calledWith(t *testing.T, want string) bool {
	t.Helper()
	raw, _ := os.ReadFile(k.calls)
	return strings.Contains(string(raw), want)
}

func (k barmanCluster) appliedSecrets(t *testing.T) map[string]map[string][]byte {
	t.Helper()
	raw, err := os.ReadFile(k.applied)
	if err != nil {
		return nil
	}
	out := map[string]map[string][]byte{}
	decoder := yaml.NewDecoder(strings.NewReader(string(raw)))
	for {
		var doc struct {
			Kind     string            `yaml:"kind"`
			Type     string            `yaml:"type"`
			Metadata map[string]string `yaml:"metadata"`
			Data     map[string]string `yaml:"data"`
		}
		if err := decoder.Decode(&doc); err == io.EOF {
			break
		} else if err != nil {
			t.Fatal(err)
		}
		if doc.Kind != "Secret" || doc.Type != "kubernetes.io/tls" || doc.Metadata["namespace"] != barmanNamespace {
			t.Fatalf("unexpected object %+v", doc)
		}
		fields := map[string][]byte{}
		for key, value := range doc.Data {
			decoded, err := base64.StdEncoding.DecodeString(value)
			if err != nil {
				t.Fatal(err)
			}
			fields[key] = decoded
		}
		out[doc.Metadata["name"]] = fields
	}
	return out
}

func barmanContext(t *testing.T) *cli.Context {
	t.Helper()
	output, err := os.Create(filepath.Join(t.TempDir(), "output"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { output.Close() })
	return &cli.Context{Env: cli.Env{Namespace: "orchard"}, Stdout: output, Stderr: output}
}

func TestBarmanCertificatesSkipAHostWithoutThePlugin(t *testing.T) {
	k := fakeBarmanKubectl(t)
	if err := renewBarmanCertificates(barmanContext(t), fixedNow); err != nil {
		t.Fatal(err)
	}
	if k.calledWith(t, "get secret") || k.calledWith(t, "apply") {
		t.Fatal("no plugin, nothing to renew")
	}
}

func TestBarmanCertificatesLeaveCertManagerAlone(t *testing.T) {
	k := fakeBarmanKubectl(t)
	k.touch(t, "deploy")
	k.touch(t, "cert-manager")
	if err := renewBarmanCertificates(barmanContext(t), fixedNow); err != nil {
		t.Fatal(err)
	}
	if k.calledWith(t, "apply") || k.calledWith(t, "rollout restart") {
		t.Fatal("cert-manager owns these secrets")
	}
}

func TestBarmanCertificatesKeepValidSecrets(t *testing.T) {
	k := fakeBarmanKubectl(t)
	k.touch(t, "deploy")
	bundle, err := issueBarmanCertificates(fixedNow)
	if err != nil {
		t.Fatal(err)
	}
	k.store(t, bundle)
	if err := renewBarmanCertificates(barmanContext(t), fixedNow.Add(600*day)); err != nil {
		t.Fatal(err)
	}
	if k.calledWith(t, "apply") || k.calledWith(t, "rollout restart") {
		t.Fatal("certificates with 130 days left stay")
	}
}

func TestBarmanCertificatesRenewBeforeExpiry(t *testing.T) {
	for name, setup := range map[string]func(k barmanCluster){
		"missing": func(barmanCluster) {},
		"expiring": func(k barmanCluster) {
			bundle, err := issueBarmanCertificates(fixedNow.Add(-650 * day))
			if err != nil {
				t.Fatal(err)
			}
			k.store(t, bundle)
		},
		"unparsable": func(k barmanCluster) {
			bundle, err := issueBarmanCertificates(fixedNow)
			if err != nil {
				t.Fatal(err)
			}
			bundle.client.cert = []byte("not a certificate")
			k.store(t, bundle)
		},
		"mismatched key": func(k barmanCluster) {
			bundle, err := issueBarmanCertificates(fixedNow)
			if err != nil {
				t.Fatal(err)
			}
			bundle.server.key = bundle.client.key
			k.store(t, bundle)
		},
	} {
		t.Run(name, func(t *testing.T) {
			k := fakeBarmanKubectl(t)
			k.touch(t, "deploy")
			setup(k)
			if err := renewBarmanCertificates(barmanContext(t), fixedNow); err != nil {
				t.Fatal(err)
			}
			secrets := k.appliedSecrets(t)
			if len(secrets) != 2 {
				t.Fatalf("want both secrets applied, got %d", len(secrets))
			}
			if !k.calledWith(t, "-n cnpg-system rollout restart deploy/plugin-barman-cloud") {
				t.Fatal("the plugin has to restart onto the new certificates")
			}
			checkBarmanSecrets(t, secrets)
		})
	}
}

func checkBarmanSecrets(t *testing.T, secrets map[string]map[string][]byte) {
	t.Helper()
	server, client := secrets[barmanServerSecret], secrets[barmanClientSecret]
	if server == nil || client == nil {
		t.Fatalf("missing a secret: %v", secrets)
	}
	if string(server["ca.crt"]) != string(client["ca.crt"]) {
		t.Fatal("both certificates come from one CA")
	}
	ca, err := firstCertificate(server["ca.crt"])
	if err != nil || !ca.IsCA {
		t.Fatalf("ca.crt isn't a CA: %v", err)
	}
	if got := ca.NotAfter.Sub(fixedNow); got != barmanCAValidity {
		t.Fatalf("CA validity %s", got)
	}
	roots := x509.NewCertPool()
	roots.AddCert(ca)
	for name, usage := range map[string]x509.ExtKeyUsage{barmanServerSecret: x509.ExtKeyUsageServerAuth, barmanClientSecret: x509.ExtKeyUsageClientAuth} {
		leaf, err := firstCertificate(secrets[name]["tls.crt"])
		if err != nil {
			t.Fatal(err)
		}
		if got := leaf.NotAfter.Sub(fixedNow); got != barmanLeafValidity {
			t.Fatalf("%s validity %s", name, got)
		}
		opts := x509.VerifyOptions{Roots: roots, KeyUsages: []x509.ExtKeyUsage{usage}, CurrentTime: fixedNow.Add(day)}
		if name == barmanServerSecret {
			opts.DNSName = "barman-cloud"
		}
		if _, err := leaf.Verify(opts); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
	}
	server0, _ := firstCertificate(server["tls.crt"])
	for _, want := range barmanServerNames {
		if server0.VerifyHostname(want) != nil {
			t.Errorf("server certificate doesn't cover %s", want)
		}
	}
}

func TestBarmanCertificatesFromTheInstallerCountAsValid(t *testing.T) {
	if _, err := exec.LookPath("openssl"); err != nil {
		t.Skip("no openssl")
	}
	dir := t.TempDir()
	cmd := exec.Command("bash", "-c", installerFunctions(t, "barman_sign_certificates")+"barman_sign_certificates")
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	read := func(name string) []byte {
		raw, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	bundle := barmanBundle{
		ca:     read("ca.crt"),
		server: barmanKeyPair{cert: read("server.crt"), key: read("server.key")},
		client: barmanKeyPair{cert: read("client.crt"), key: read("client.key")},
	}
	now := time.Now()
	for name, pair := range map[string]barmanKeyPair{"server": bundle.server, "client": bundle.client} {
		if !barmanPairValid(pair.cert, pair.key, bundle.ca, now) {
			t.Fatalf("orchardctl would replace the installer's %s certificate at once", name)
		}
		if barmanPairValid(pair.cert, pair.key, bundle.ca, now.Add(650*day)) {
			t.Fatalf("the installer's %s certificate should be due for renewal 80 days before expiry", name)
		}
	}
	checkMutualTLS(t, bundle)
}

func TestBarmanCertificatesWorkTheWayCloudNativePGUsesThem(t *testing.T) {
	bundle, err := issueBarmanCertificates(time.Now().Add(-time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	checkMutualTLS(t, bundle)
}

func checkMutualTLS(t *testing.T, bundle barmanBundle) {
	t.Helper()
	clientCAs := x509.NewCertPool()
	clientCAs.AppendCertsFromPEM(bundle.client.cert)
	serverPair, err := tls.X509KeyPair(bundle.server.cert, bundle.server.key)
	if err != nil {
		t.Fatal(err)
	}
	listener, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{
		ClientAuth:   tls.RequireAndVerifyClientCert,
		ClientCAs:    clientCAs,
		Certificates: []tls.Certificate{serverPair},
		MinVersion:   tls.VersionTLS13,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	served := make(chan error, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			served <- err
			return
		}
		defer conn.Close()
		if err := conn.(*tls.Conn).Handshake(); err != nil {
			served <- err
			return
		}
		_, err = conn.Write([]byte("ok"))
		served <- err
	}()

	serverRoots := x509.NewCertPool()
	serverRoots.AppendCertsFromPEM(bundle.server.cert)
	clientPair, err := tls.X509KeyPair(bundle.client.cert, bundle.client.key)
	if err != nil {
		t.Fatal(err)
	}
	conn, err := tls.Dial("tcp", listener.Addr().(*net.TCPAddr).String(), &tls.Config{
		ServerName:   "barman-cloud",
		RootCAs:      serverRoots,
		Certificates: []tls.Certificate{clientPair},
		MinVersion:   tls.VersionTLS13,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	reply, err := io.ReadAll(conn)
	if err != nil || string(reply) != "ok" {
		t.Fatalf("mTLS failed: %q %v", reply, err)
	}
	if err := <-served; err != nil {
		t.Fatal(err)
	}
}

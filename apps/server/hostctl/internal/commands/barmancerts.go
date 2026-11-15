package commands

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"math/big"
	"strings"
	"time"

	"github.com/hackclub/orchard/orchardctl/internal/cli"
)

const (
	barmanNamespace    = "cnpg-system"
	barmanDeployment   = "plugin-barman-cloud"
	barmanServerSecret = "barman-cloud-server-tls"
	barmanClientSecret = "barman-cloud-client-tls"
	barmanRenewBefore  = 90 * 24 * time.Hour
	barmanCAValidity   = 3650 * 24 * time.Hour
	barmanLeafValidity = 730 * 24 * time.Hour
)

var barmanServerNames = []string{
	"barman-cloud",
	"barman-cloud.cnpg-system",
	"barman-cloud.cnpg-system.svc",
	"barman-cloud.cnpg-system.svc.cluster.local",
}

type barmanKeyPair struct {
	cert []byte
	key  []byte
}

type barmanBundle struct {
	ca     []byte
	server barmanKeyPair
	client barmanKeyPair
}

func renewBarmanCertificates(c *cli.Context, now time.Time) error {
	if _, err := c.Capture("kubectl", "-n", barmanNamespace, "get", "deploy", barmanDeployment, "-o", "name"); err != nil {
		return nil
	}
	managed, _ := c.Capture("kubectl", "-n", barmanNamespace, "get", "certificates.cert-manager.io", "barman-cloud-server", "barman-cloud-client", "-o", "name")
	if strings.TrimSpace(managed) != "" {
		return nil
	}
	if barmanSecretValid(c, barmanServerSecret, now) && barmanSecretValid(c, barmanClientSecret, now) {
		return nil
	}
	c.Printf("issuing new certificates for the Barman Cloud plugin\n")
	bundle, err := issueBarmanCertificates(now)
	if err != nil {
		return err
	}
	if err := c.RunWithInput(barmanSecretsManifest(bundle), "kubectl", "apply", "-f", "-"); err != nil {
		return err
	}
	return c.Run("kubectl", "-n", barmanNamespace, "rollout", "restart", "deploy/"+barmanDeployment)
}

func barmanSecretValid(c *cli.Context, name string, now time.Time) bool {
	raw, err := c.Capture("kubectl", "-n", barmanNamespace, "get", "secret", name, "-o", "json")
	if err != nil {
		return false
	}
	var secret struct {
		Data map[string]string `json:"data"`
	}
	if err := json.Unmarshal([]byte(raw), &secret); err != nil {
		return false
	}
	field := func(key string) []byte {
		decoded, err := base64.StdEncoding.DecodeString(secret.Data[key])
		if err != nil {
			return nil
		}
		return decoded
	}
	return barmanPairValid(field("tls.crt"), field("tls.key"), field("ca.crt"), now)
}

func barmanPairValid(certPEM, keyPEM, caPEM []byte, now time.Time) bool {
	if _, err := firstCertificate(caPEM); err != nil {
		return false
	}
	leaf, err := firstCertificate(certPEM)
	if err != nil {
		return false
	}
	if now.Before(leaf.NotBefore) || leaf.NotAfter.Sub(now) <= barmanRenewBefore {
		return false
	}
	_, err = tls.X509KeyPair(certPEM, keyPEM)
	return err == nil
}

func firstCertificate(raw []byte) (*x509.Certificate, error) {
	for {
		var block *pem.Block
		block, raw = pem.Decode(raw)
		if block == nil {
			return nil, fmt.Errorf("no certificate")
		}
		if block.Type == "CERTIFICATE" {
			return x509.ParseCertificate(block.Bytes)
		}
	}
}

func issueBarmanCertificates(now time.Time) (barmanBundle, error) {
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return barmanBundle{}, err
	}
	caTemplate := &x509.Certificate{
		Subject:               pkix.Name{CommonName: "barman-cloud-ca"},
		NotBefore:             now,
		NotAfter:              now.Add(barmanCAValidity),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
	}
	caDER, caCert, err := signCertificate(caTemplate, caTemplate, &caKey.PublicKey, caKey)
	if err != nil {
		return barmanBundle{}, err
	}
	caPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER})

	leaf := func(name string, usage x509.ExtKeyUsage, dnsNames []string) (barmanKeyPair, error) {
		key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			return barmanKeyPair{}, err
		}
		template := &x509.Certificate{
			Subject:               pkix.Name{CommonName: name},
			DNSNames:              dnsNames,
			NotBefore:             now,
			NotAfter:              now.Add(barmanLeafValidity),
			BasicConstraintsValid: true,
			KeyUsage:              x509.KeyUsageDigitalSignature,
			ExtKeyUsage:           []x509.ExtKeyUsage{usage},
		}
		der, _, err := signCertificate(template, caCert, &key.PublicKey, caKey)
		if err != nil {
			return barmanKeyPair{}, err
		}
		keyDER, err := x509.MarshalPKCS8PrivateKey(key)
		if err != nil {
			return barmanKeyPair{}, err
		}
		cert := append(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), caPEM...)
		return barmanKeyPair{cert: cert, key: pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER})}, nil
	}

	server, err := leaf("barman-cloud-server", x509.ExtKeyUsageServerAuth, barmanServerNames)
	if err != nil {
		return barmanBundle{}, err
	}
	client, err := leaf("barman-cloud-client", x509.ExtKeyUsageClientAuth, nil)
	if err != nil {
		return barmanBundle{}, err
	}
	return barmanBundle{ca: caPEM, server: server, client: client}, nil
}

func signCertificate(template, parent *x509.Certificate, pub *ecdsa.PublicKey, signer *ecdsa.PrivateKey) ([]byte, *x509.Certificate, error) {
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 127))
	if err != nil {
		return nil, nil, err
	}
	template.SerialNumber = serial.Add(serial, big.NewInt(1))
	der, err := x509.CreateCertificate(rand.Reader, template, parent, pub, signer)
	if err != nil {
		return nil, nil, err
	}
	cert, err := x509.ParseCertificate(der)
	return der, cert, err
}

func barmanSecretsManifest(b barmanBundle) string {
	secret := func(name string, pair barmanKeyPair) string {
		return fmt.Sprintf(`apiVersion: v1
kind: Secret
metadata:
  name: %s
  namespace: %s
type: kubernetes.io/tls
data:
  tls.crt: %s
  tls.key: %s
  ca.crt: %s
`, name, barmanNamespace,
			base64.StdEncoding.EncodeToString(pair.cert),
			base64.StdEncoding.EncodeToString(pair.key),
			base64.StdEncoding.EncodeToString(b.ca))
	}
	return secret(barmanServerSecret, b.server) + "---\n" + secret(barmanClientSecret, b.client)
}

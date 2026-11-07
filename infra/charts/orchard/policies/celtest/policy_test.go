package celtest

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/google/cel-go/cel"
	"k8s.io/apiserver/pkg/cel/environment"
	"sigs.k8s.io/yaml"
)

type policy struct {
	Name       string
	Spec       map[string]any
	Conditions []map[string]any
	Variables  []map[string]any
	Validation []map[string]any
	Rules      []map[string]any
}

func toAny(v any) any {
	switch t := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, x := range t {
			out[k] = toAny(x)
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, x := range t {
			out[i] = toAny(x)
		}
		return out
	case float64:
		if t == float64(int64(t)) {
			return int64(t)
		}
		return t
	}
	return v
}

func splitDocs(data []byte) [][]byte {
	var docs [][]byte
	for _, d := range bytes.Split(data, []byte("\n---")) {
		if len(bytes.TrimSpace(stripComments(d))) > 0 {
			docs = append(docs, d)
		}
	}
	return docs
}

func stripComments(d []byte) []byte {
	var out [][]byte
	for _, l := range bytes.Split(d, []byte("\n")) {
		if !bytes.HasPrefix(bytes.TrimSpace(l), []byte("#")) {
			out = append(out, l)
		}
	}
	return bytes.Join(out, []byte("\n"))
}

func parseDoc(t *testing.T, d []byte) map[string]any {
	t.Helper()
	var m map[string]any
	if err := yaml.Unmarshal(d, &m); err != nil {
		t.Fatalf("yaml: %v", err)
	}
	return toAny(m).(map[string]any)
}

func list(m map[string]any, path ...string) []any {
	var cur any = m
	for _, p := range path {
		mm, ok := cur.(map[string]any)
		if !ok {
			return nil
		}
		cur = mm[p]
	}
	l, _ := cur.([]any)
	return l
}

func str(v any) string {
	s, _ := v.(string)
	return s
}

func loadPolicies(t *testing.T) []map[string]any {
	data, err := os.ReadFile("../orchard-tenant-policies.yaml")
	if err != nil {
		t.Fatal(err)
	}
	var out []map[string]any
	for _, d := range splitDocs(data) {
		out = append(out, parseDoc(t, d))
	}
	return out
}

func newEnv(t *testing.T) *cel.Env {
	base := environment.MustBaseEnvSet(environment.DefaultCompatibilityVersion(), true)
	env, err := base.Env(environment.StoredExpressions)
	if err != nil {
		t.Fatal(err)
	}
	env, err = env.Extend(
		cel.Variable("object", cel.DynType),
		cel.Variable("oldObject", cel.DynType),
		cel.Variable("request", cel.DynType),
		cel.Variable("params", cel.DynType),
		cel.Variable("variables", cel.MapType(cel.StringType, cel.DynType)),
	)
	if err != nil {
		t.Fatal(err)
	}
	return env
}

func evalExpr(env *cel.Env, expr string, act map[string]any) (any, error) {
	ast, iss := env.Compile(expr)
	if iss != nil && iss.Err() != nil {
		return nil, fmt.Errorf("compile: %w", iss.Err())
	}
	prg, err := env.Program(ast)
	if err != nil {
		return nil, err
	}
	out, _, err := prg.Eval(act)
	if err != nil {
		return nil, err
	}
	return out.Value(), nil
}

var resources = map[string][2]string{
	"Pod":                   {"", "pods"},
	"Service":               {"", "services"},
	"PersistentVolumeClaim": {"", "persistentvolumeclaims"},
	"Namespace":             {"", "namespaces"},
	"EndpointSlice":         {"discovery.k8s.io", "endpointslices"},
	"Ingress":               {"networking.k8s.io", "ingresses"},
	"NetworkPolicy":         {"networking.k8s.io", "networkpolicies"},
	"RoleBinding":           {"rbac.authorization.k8s.io", "rolebindings"},
	"Cluster":               {"postgresql.cnpg.io", "clusters"},
}

func matches(pol map[string]any, obj map[string]any, op string) bool {
	rt, ok := resources[str(obj["kind"])]
	if !ok {
		return false
	}
	for _, r := range list(pol, "spec", "matchConstraints", "resourceRules") {
		rm := r.(map[string]any)
		if !contains(rm["apiGroups"], rt[0]) || !contains(rm["resources"], rt[1]) || !contains(rm["operations"], op) {
			continue
		}
		return true
	}
	return false
}

func contains(v any, s string) bool {
	for _, x := range v.([]any) {
		if x == s || x == "*" {
			return true
		}
	}
	return false
}

type directives map[string]string

func parseDirectives(data []byte) directives {
	d := directives{}
	for _, l := range strings.Split(string(data), "\n") {
		l = strings.TrimSpace(l)
		if !strings.HasPrefix(l, "# ") {
			continue
		}
		kv := strings.SplitN(strings.TrimPrefix(l, "# "), ":", 2)
		if len(kv) == 2 {
			switch strings.TrimSpace(kv[0]) {
			case "user", "groups", "operation", "params", "denied-by", "matches", "warns", "set":
				d[strings.TrimSpace(kv[0])] = strings.TrimSpace(kv[1])
			}
		}
	}
	return d
}

func loadParams(t *testing.T) map[string]any {
	data, err := os.ReadFile("../fixtures/params.yaml")
	if err != nil {
		t.Fatal(err)
	}
	return parseDoc(t, data)
}

func decide(t *testing.T, env *cel.Env, pols []map[string]any, obj, old map[string]any, d directives, params map[string]any) (denials []string, matched []string) {
	op := d["operation"]
	if op == "" {
		op = "CREATE"
	}
	user := d["user"]
	if user == "" {
		user = "system:serviceaccount:kube-system:replicaset-controller"
	}
	groups := []any{"system:authenticated"}
	if g := d["groups"]; g != "" {
		groups = nil
		for _, x := range strings.Split(g, ",") {
			groups = append(groups, x)
		}
	}
	var p any
	if d["params"] != "none" {
		cp := toAny(params).(map[string]any)
		data := map[string]any{}
		for k, v := range cp["data"].(map[string]any) {
			data[k] = v
		}
		if kvs := d["set"]; kvs != "" {
			for _, kv := range strings.Split(kvs, ",") {
				parts := strings.SplitN(kv, "=", 2)
				data[parts[0]] = parts[1]
			}
		}
		cp["data"] = data
		p = cp
	}
	for _, pol := range pols {
		if str(pol["kind"]) != "ValidatingAdmissionPolicy" || !matches(pol, obj, op) {
			continue
		}
		name := str(pol["metadata"].(map[string]any)["name"])
		matched = append(matched, name)
		var oldv any
		if old != nil {
			oldv = old
		}
		act := map[string]any{
			"object":    obj,
			"oldObject": oldv,
			"request": map[string]any{
				"operation": op,
				"userInfo":  map[string]any{"username": user, "groups": groups},
			},
			"params":    p,
			"variables": map[string]any{},
		}
		skip := false
		for _, c := range list(pol, "spec", "matchConditions") {
			v, err := evalExpr(env, str(c.(map[string]any)["expression"]), act)
			if err != nil {
				t.Errorf("%s: matchCondition error: %v", name, err)
				skip = true
				break
			}
			if v != true {
				skip = true
				break
			}
		}
		if skip {
			continue
		}
		vars := act["variables"].(map[string]any)
		for _, v := range list(pol, "spec", "variables") {
			vm := v.(map[string]any)
			val, err := evalExpr(env, str(vm["expression"]), act)
			if err != nil {
				t.Errorf("%s: variable %s error: %v", name, str(vm["name"]), err)
				continue
			}
			vars[str(vm["name"])] = val
		}
		for _, v := range list(pol, "spec", "validations") {
			vm := v.(map[string]any)
			val, err := evalExpr(env, str(vm["expression"]), act)
			if err != nil {
				t.Errorf("%s: validation error (%s): %v", name, str(vm["message"]), err)
				continue
			}
			if val != true {
				denials = append(denials, name+": "+str(vm["message"]))
			}
		}
	}
	return denials, matched
}

func runDir(t *testing.T, dir string, wantDeny bool, noParams ...bool) {
	files, _ := filepath.Glob(filepath.Join("..", "fixtures", dir, "*.yaml"))
	if len(files) == 0 {
		t.Fatalf("no fixtures in %s", dir)
	}
	sort.Strings(files)
	pols := loadPolicies(t)
	env := newEnv(t)
	params := loadParams(t)
	for _, f := range files {
		f := f
		t.Run(filepath.Base(f), func(t *testing.T) {
			data, err := os.ReadFile(f)
			if err != nil {
				t.Fatal(err)
			}
			docs := splitDocs(data)
			obj := parseDoc(t, docs[0])
			var old map[string]any
			if len(docs) > 1 {
				old = parseDoc(t, docs[1])
			}
			d := parseDirectives(data)
			if len(noParams) > 0 && noParams[0] {
				d["params"] = "none"
			}
			denials, matched := decide(t, env, pols, obj, old, d, params)
			if len(matched) == 0 && d["matches"] != "none" {
				t.Fatalf("no policy matches %s (vacuous fixture)", f)
			}
			if wantDeny {
				if len(denials) == 0 {
					t.Fatalf("hostile fixture was allowed (matched %v)", matched)
				}
				if want := d["denied-by"]; want != "" {
					found := false
					for _, x := range denials {
						if strings.Contains(x, want) {
							found = true
						}
					}
					if !found {
						t.Fatalf("denied by %v, want %q", denials, want)
					}
				}
				return
			}
			warned := 0
			for _, x := range denials {
				name := strings.SplitN(x, ":", 2)[0]
				if d["warns"] == name {
					warned++
					continue
				}
				t.Fatalf("benign fixture denied: %v", denials)
			}
			if d["warns"] != "" && warned == 0 {
				t.Fatalf("expected a %s warning, got none", d["warns"])
			}
		})
	}
}

func TestBenign(t *testing.T) { runDir(t, "benign", false) }

func TestBenignWithoutParams(t *testing.T) { runDir(t, "benign", false, true) }

func TestHostile(t *testing.T) { runDir(t, "hostile", true) }

func TestPoliciesCompile(t *testing.T) {
	env := newEnv(t)
	act := map[string]any{
		"object": map[string]any{}, "oldObject": nil, "request": map[string]any{},
		"params": nil, "variables": map[string]any{},
	}
	for _, pol := range loadPolicies(t) {
		name := str(pol["metadata"].(map[string]any)["name"])
		var exprs []string
		for _, key := range []string{"matchConditions", "variables", "validations"} {
			for _, e := range list(pol, "spec", key) {
				exprs = append(exprs, str(e.(map[string]any)["expression"]))
			}
		}
		for _, e := range exprs {
			if _, iss := env.Compile(e); iss != nil && iss.Err() != nil {
				t.Errorf("%s: %v\n%s", name, iss.Err(), e)
			}
		}
	}
	_ = act
}

func TestBundleJSON(t *testing.T) {
	target := os.Getenv("WRITE_BUNDLE")
	if target == "" {
		t.Skip()
	}
	var out []map[string]any
	for _, dir := range []string{"benign", "hostile"} {
		files, _ := filepath.Glob(filepath.Join("..", "fixtures", dir, "*.yaml"))
		sort.Strings(files)
		for _, f := range files {
			data, _ := os.ReadFile(f)
			docs := splitDocs(data)
			d := parseDirectives(data)
			expect := "allow"
			if dir == "hostile" {
				expect = "deny"
			}
			entry := map[string]any{
				"name": dir + "/" + strings.TrimSuffix(filepath.Base(f), ".yaml"), "expect": expect, "object": parseDoc(t, docs[0]),
			}
			if len(docs) > 1 {
				entry["oldObject"] = parseDoc(t, docs[1])
			}
			for _, k := range []string{"user", "groups", "operation", "set", "params", "denied-by", "warns"} {
				if d[k] != "" {
					entry[k] = d[k]
				}
			}
			out = append(out, entry)
		}
	}
	b, err := json.MarshalIndent(out, "", " ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, b, 0o644); err != nil {
		t.Fatal(err)
	}
}

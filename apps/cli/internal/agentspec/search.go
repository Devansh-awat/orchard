package agentspec

import (
	"math"
	"regexp"
	"sort"
	"strings"
)

type Hit struct {
	OperationID string  `json:"operationId"`
	Method      string  `json:"method"`
	Path        string  `json:"path"`
	Summary     string  `json:"summary"`
	Score       float64 `json:"score"`
	Sensitive   bool    `json:"sensitive,omitempty"`
	Destructive bool    `json:"destructive,omitempty"`
}

var stopwords = map[string]bool{
	"a": true, "an": true, "the": true, "to": true, "of": true, "for": true, "and": true, "or": true,
	"in": true, "on": true, "my": true, "me": true, "i": true, "is": true, "it": true, "by": true,
	"with": true, "from": true, "all": true, "how": true, "what": true, "which": true, "do": true,
}

var synonyms = map[string][]string{
	"app":         {"deployment"},
	"service":     {"deployment", "service"},
	"db":          {"database"},
	"postgres":    {"database"},
	"domain":      {"ingress"},
	"url":         {"ingress"},
	"hostname":    {"ingress"},
	"secret":      {"env", "secret"},
	"variable":    {"env"},
	"var":         {"env"},
	"environment": {"environment", "env"},
	"crash":       {"rollout", "killed", "error"},
	"crashing":    {"rollout", "killed", "error"},
	"broken":      {"rollout", "error"},
	"live":        {"rollout", "live"},
	"add":         {"create"},
	"new":         {"create"},
	"remove":      {"delete"},
	"show":        {"get"},
	"change":      {"update", "set"},
	"edit":        {"update", "set"},
	"restart":     {"restart"},
	"redeploy":    {"rebuild", "redeploy"},
	"deploy":      {"deployment", "deploy"},
	"cron":        {"job"},
	"schedule":    {"schedule", "job"},
	"log":         {"log"},
	"credential":  {"credential", "connection"},
	"password":    {"password", "connection"},
	"connection":  {"connection"},
	"status":      {"status", "rollout"},
	"rollout":     {"rollout"},
	"team":        {"organization", "member"},
	"org":         {"organization"},
	"user":        {"user", "member"},
}

const (
	synonymWeight = 0.9
	densityWeight = 0.5
	weightID      = 3.0
	weightPath    = 2.5
	weightSummary = 2.0
	weightTags    = 1.5
)

var (
	camelBoundary = regexp.MustCompile(`([a-z0-9])([A-Z])`)
	nonAlnum      = regexp.MustCompile(`[^a-z0-9]+`)
)

func stem(token string) string {
	if len(token) > 3 && strings.HasSuffix(token, "ies") {
		return token[:len(token)-3] + "y"
	}
	if len(token) > 4 && strings.HasSuffix(token, "sses") {
		return token[:len(token)-2]
	}
	if len(token) > 3 && strings.HasSuffix(token, "s") && !strings.HasSuffix(token, "ss") && !strings.HasSuffix(token, "us") {
		return token[:len(token)-1]
	}
	return token
}

func Tokenize(text string) []string {
	spaced := strings.ToLower(camelBoundary.ReplaceAllString(text, "$1 $2"))
	out := []string{}
	for _, raw := range nonAlnum.Split(spaced, -1) {
		if raw == "" || stopwords[raw] {
			continue
		}
		out = append(out, stem(raw))
	}
	return out
}

func staticPathText(path string) string {
	parts := []string{}
	for _, segment := range strings.Split(path, "/") {
		if segment == "" || strings.HasPrefix(segment, ":") || strings.HasPrefix(segment, "{") {
			continue
		}
		parts = append(parts, segment)
	}
	return strings.Join(parts, " ")
}

type field struct {
	weight float64
	tokens map[string]bool
}

func toSet(tokens []string) map[string]bool {
	set := map[string]bool{}
	for _, token := range tokens {
		set[token] = true
	}
	return set
}

func index(op Operation) []field {
	tagTokens := []string{}
	for _, tag := range op.Tags {
		tagTokens = append(tagTokens, Tokenize(tag)...)
	}
	return []field{
		{weightID, toSet(Tokenize(op.OperationID))},
		{weightPath, toSet(Tokenize(staticPathText(op.Path)))},
		{weightSummary, toSet(Tokenize(op.Summary))},
		{weightTags, toSet(tagTokens)},
	}
}

func termWeight(term string, fields []field) float64 {
	best := 0.0
	for _, f := range fields {
		if f.tokens[term] {
			best = math.Max(best, f.weight)
			continue
		}
		if len(term) < 3 {
			continue
		}
		for token := range f.tokens {
			if len(token) >= 3 && (strings.HasPrefix(token, term) || strings.HasPrefix(term, token)) {
				best = math.Max(best, f.weight/2)
				break
			}
		}
	}
	return best
}

func expand(token string) []string {
	out := []string{token}
	for _, synonym := range synonyms[token] {
		out = append(out, stem(synonym))
	}
	return out
}

func Score(query string, op Operation) float64 {
	terms := Tokenize(query)
	if len(terms) == 0 {
		return 0
	}
	fields := index(op)
	idTokens := fields[0].tokens
	hitID := map[string]bool{}
	total := 0.0
	matched := 0
	for _, term := range terms {
		best := 0.0
		for i, candidate := range expand(term) {
			factor := 1.0
			if i > 0 {
				factor = synonymWeight
			}
			best = math.Max(best, termWeight(candidate, fields)*factor)
			if idTokens[candidate] {
				hitID[candidate] = true
			}
		}
		if best > 0 {
			matched++
		}
		total += best
	}
	if matched == 0 {
		return 0
	}
	coverage := float64(matched) / float64(len(terms))
	density := 0.0
	if len(idTokens) > 0 {
		density = float64(len(hitID)) / float64(len(idTokens))
	}
	depth := len(strings.Fields(strings.ReplaceAll(op.Path, "/", " ")))
	score := total*coverage + density*densityWeight - float64(depth)*0.01
	return math.Round(score*1000) / 1000
}

func Search(ops []Operation, query string, limit int) []Hit {
	if limit < 1 {
		limit = 1
	}
	hits := []Hit{}
	for _, op := range ops {
		score := Score(query, op)
		if score <= 0 {
			continue
		}
		hits = append(hits, Hit{
			OperationID: op.OperationID,
			Method:      op.Method,
			Path:        op.Path,
			Summary:     op.Summary,
			Score:       score,
			Sensitive:   op.Sensitive,
			Destructive: op.Destructive,
		})
	}
	sort.SliceStable(hits, func(i, j int) bool {
		if hits[i].Score != hits[j].Score {
			return hits[i].Score > hits[j].Score
		}
		return hits[i].OperationID < hits[j].OperationID
	})
	if len(hits) > limit {
		hits = hits[:limit]
	}
	return hits
}

func isParam(segment string) bool {
	return strings.HasPrefix(segment, ":") || strings.HasPrefix(segment, "{")
}

func segments(path string) []string {
	out := []string{}
	for _, s := range strings.Split(path, "/") {
		if s != "" {
			out = append(out, s)
		}
	}
	return out
}

func matchesTemplate(template, concrete string) bool {
	left, right := segments(template), segments(concrete)
	if len(left) != len(right) {
		return false
	}
	for i, segment := range left {
		if !isParam(segment) && segment != right[i] {
			return false
		}
	}
	return true
}

func staticCount(path string) int {
	n := 0
	for _, s := range segments(path) {
		if !isParam(s) {
			n++
		}
	}
	return n
}

var methodPath = regexp.MustCompile(`^([A-Za-z]+)\s+(/\S*)$`)

func Find(ops []Operation, ref string) (Operation, bool) {
	ref = strings.TrimSpace(ref)
	for _, op := range ops {
		if op.OperationID == ref {
			return op, true
		}
	}
	m := methodPath.FindStringSubmatch(ref)
	if m == nil {
		return Operation{}, false
	}
	method := strings.ToUpper(m[1])
	path := strings.SplitN(m[2], "?", 2)[0]
	if trimmed := strings.TrimRight(path, "/"); trimmed != "" {
		path = trimmed
	}
	var best *Operation
	for i := range ops {
		op := ops[i]
		if op.Method != method {
			continue
		}
		if op.Path == path {
			return op, true
		}
		if matchesTemplate(op.Path, path) && (best == nil || staticCount(op.Path) > staticCount(best.Path)) {
			best = &ops[i]
		}
	}
	if best == nil {
		return Operation{}, false
	}
	return *best, true
}

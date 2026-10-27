package agentspec

import (
	"net/url"
	"regexp"
	"sort"
)

var placeholder = regexp.MustCompile(`:([A-Za-z0-9_]+)|\{\*?([A-Za-z0-9_]+)\}`)

func FillPath(template string, params map[string]string) (string, []string) {
	missing := []string{}
	filled := placeholder.ReplaceAllStringFunc(template, func(match string) string {
		groups := placeholder.FindStringSubmatch(match)
		name := groups[1]
		if name == "" {
			name = groups[2]
		}
		value, ok := params[name]
		if !ok || value == "" {
			missing = append(missing, name)
			return match
		}
		return url.PathEscape(value)
	})
	return filled, missing
}

func PathParamNames(template string) []string {
	names := []string{}
	for _, groups := range placeholder.FindAllStringSubmatch(template, -1) {
		if groups[1] != "" {
			names = append(names, groups[1])
		} else {
			names = append(names, groups[2])
		}
	}
	return names
}

func UnknownParams(template string, params map[string]string) []string {
	known := map[string]bool{}
	for _, name := range PathParamNames(template) {
		known[name] = true
	}
	unknown := []string{}
	for name := range params {
		if !known[name] {
			unknown = append(unknown, name)
		}
	}
	sort.Strings(unknown)
	return unknown
}

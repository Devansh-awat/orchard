package termsession

import "testing"

func TestControlFrameSwallowsOnlyTheAttachHandshake(t *testing.T) {
	yes := []string{
		`{"type":"attached","handle":"v1.abc","resumed":false,"reason":"new","replayedBytes":0}`,
		"  {\"type\":\"attached\"}\r\n",
	}
	for _, s := range yes {
		if !controlFrame([]byte(s)) {
			t.Errorf("expected control frame: %q", s)
		}
	}
	no := []string{
		"/app # exec node",
		`{"type":"resize","cols":80,"rows":24}`,
		`{"not":"json"`,
		`{"level":"info","type":"attached"} extra`,
		"",
	}
	for _, s := range no {
		if controlFrame([]byte(s)) {
			t.Errorf("must pass through: %q", s)
		}
	}
}

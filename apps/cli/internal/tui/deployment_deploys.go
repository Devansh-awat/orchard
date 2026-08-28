package tui

import (
	"fmt"
	"net/url"
	"strings"

	"github.com/hackclub/orchard/cli/internal/api"
	tea "github.com/charmbracelet/bubbletea"
)

// Deploys tab: image history with rollback, webhook trigger tokens, and the
// push-to-deploy toggle. Endpoints mirror cmd/deploy_release.go.

func (s *deploymentScreen) deploysKey(msg tea.KeyMsg) (tea.Cmd, bool) {
	d := s.detail
	switch msg.String() {
	case "p":
		s.deployPane = 1 - s.deployPane
		return nil, true
	case "up", "k":
		if s.deployPane == 0 && s.histCursor > 0 {
			s.histCursor--
		} else if s.deployPane == 1 && s.tokCursor > 0 {
			s.tokCursor--
		}
		return nil, true
	case "down", "j":
		if s.deployPane == 0 && d != nil && s.histCursor < len(d.ImageHistory)-1 {
			s.histCursor++
		} else if s.deployPane == 1 && s.tokCursor < len(s.tokens)-1 {
			s.tokCursor++
		}
		return nil, true
	case "R":
		if s.deployPane != 0 || d == nil || s.histCursor >= len(d.ImageHistory) {
			return nil, true
		}
		e := d.ImageHistory[s.histCursor]
		if e.IsActive {
			return flashf("that image is already active"), true
		}
		s.confirm.Show(fmt.Sprintf("Rollback %s to %s (%s)?", s.name, e.Image, orDash(e.Tag)),
			doAction(s.cl, "POST", "/deployments/"+url.PathEscape(s.id)+"/rollback/"+url.PathEscape(e.ID),
				nil, "rollback started"))
		return nil, true
	case "a":
		if s.deployPane != 0 || d == nil {
			return nil, true
		}
		if d.AutoDeployEnabled {
			s.confirm.Show("Disable auto-deploy? Pushes will no longer trigger rebuilds.",
				doAction(s.cl, "POST", "/deployments/"+url.PathEscape(s.id)+"/auto-deploy/disable",
					nil, "auto-deploy disabled"))
			return nil, true
		}
		return push(newAutoDeployForm(s.cl, s.id, d.GithubBranch)), true
	case "n":
		if s.deployPane == 1 {
			return push(newWebhookTokenForm(s.cl, s.id)), true
		}
		return nil, true
	case "x":
		if s.deployPane == 1 && s.tokCursor < len(s.tokens) {
			t := s.tokens[s.tokCursor]
			label := t.Label
			if label == "" {
				label = t.ID
			}
			s.confirm.Show(fmt.Sprintf("Delete webhook token %q? Its trigger URL stops working.", label),
				doAction(s.cl, "DELETE",
					"/deployments/"+url.PathEscape(s.id)+"/webhook-tokens/"+url.PathEscape(t.ID),
					nil, "deleted webhook token"))
		}
		return nil, true
	}
	return nil, false
}

func (s *deploymentScreen) viewDeploys(height int, strip string) string {
	d := s.detail
	if d == nil {
		return panelRaw(strip, stMuted.Render("  no data"), s.w, height, true)
	}
	histH := height * 3 / 5
	if histH < 6 {
		histH = min(6, height-4)
	}
	tokH := height - histH

	histCursor, tokCursor := s.histCursor, s.tokCursor
	if s.deployPane != 0 {
		histCursor = -1
	}
	if s.deployPane != 1 {
		tokCursor = -1
	}

	rows := make([][]string, len(d.ImageHistory))
	for i, e := range d.ImageHistory {
		active := ""
		if e.IsActive {
			active = stGreen.Render("● active")
		}
		msg := e.CommitMessage
		if i := strings.IndexByte(msg, '\n'); i >= 0 {
			msg = msg[:i]
		}
		rows[i] = []string{
			truncate(e.Image, 34),
			orDash(e.Tag),
			orDash(e.Branch),
			stMuted.Render(shortSha(e.CommitSha)),
			stMuted.Render(truncate(msg, 28)),
			stMuted.Render(fmtDate(e.CreatedAt)),
			active,
		}
	}
	histBody := renderTable(
		[]col{{title: "IMAGE"}, {title: "TAG"}, {title: "BRANCH"}, {title: "COMMIT"}, {title: "MESSAGE"}, {title: "BUILT"}, {title: ""}},
		rows, histCursor, s.w-2, histH-2)

	auto := stMuted.Render("auto-deploy ") + onOff(d.AutoDeployEnabled)
	if d.AutoDeployEnabled && d.AutoDeployBranch != "" {
		auto += stMuted.Render(" · branch " + d.AutoDeployBranch)
	}
	histTitle := strip + stMuted.Render("   ") + auto

	var tok strings.Builder
	if s.tokensErr != nil {
		tok.WriteString("  " + stRed.Render("✗ "+s.tokensErr.Error()))
	} else {
		tokRows := make([][]string, len(s.tokens))
		for i, t := range s.tokens {
			tokRows[i] = []string{orDash(t.Label), stMuted.Render(t.ID), stMuted.Render(fmtDate(t.CreatedAt))}
		}
		tok.WriteString(renderTable([]col{{title: "LABEL"}, {title: "ID"}, {title: "CREATED"}},
			tokRows, tokCursor, s.w-2, tokH-3))
	}
	if s.newToken != "" {
		tok.WriteString("\n " + stYellow.Render("new secret (shown once): ") + stTitle.Render(s.newToken))
	}

	hist := panelRaw(histTitle, histBody, s.w, histH, s.deployPane == 0)
	tokens := panel(fmt.Sprintf("Webhook tokens (%d)", len(s.tokens)), tok.String(), s.w, tokH, s.deployPane == 1)
	return hist + "\n" + tokens
}

func newWebhookTokenForm(cl *api.Client, depID string) *formScreen {
	return newForm("New webhook token",
		"Mints a token that triggers a rebuild via POST. The secret is shown once.",
		[]*field{fld("label", "Label", "ci-main", false)},
		func(v map[string]string) tea.Cmd {
			return createWebhookToken(cl, depID, v["label"])
		})
}

func newAutoDeployForm(cl *api.Client, depID, branch string) *formScreen {
	f := fld("branch", "Branch", "main", true)
	if branch != "" {
		f.ti.SetValue(branch)
	}
	return newForm("Enable auto-deploy",
		"Rebuild automatically on pushes to this branch.",
		[]*field{f},
		func(v map[string]string) tea.Cmd {
			return func() tea.Msg {
				body := map[string]any{"branch": v["branch"]}
				err := cl.Send(ctxBG(), "POST", "/deployments/"+url.PathEscape(depID)+"/auto-deploy/enable", body, nil)
				return formResult{ok: actionMsg{text: "auto-deploy enabled from " + v["branch"]}, err: err}
			}
		})
}

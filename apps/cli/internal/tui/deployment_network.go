package tui

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"

	"github.com/hackclub/orchard/cli/internal/api"
	tea "github.com/charmbracelet/bubbletea"
)

// Network tab: services/ports, domains (ingresses), and Tailscale exposure.
// Endpoints mirror cmd/service.go, cmd/domain.go, and cmd/tailscale.go.

func (s *deploymentScreen) servicesPath(segments ...string) string {
	p := "/deployments/" + url.PathEscape(s.id) + "/services"
	for _, seg := range segments {
		p += "/" + url.PathEscape(seg)
	}
	return p
}

func (s *deploymentScreen) networkKey(msg tea.KeyMsg) (tea.Cmd, bool) {
	d := s.detail
	switch msg.String() {
	case "p":
		s.netPane = 1 - s.netPane
		return nil, true
	case "up", "k":
		if s.netPane == 0 && s.svcCursor > 0 {
			s.svcCursor--
		} else if s.netPane == 1 && s.domCursor > 0 {
			s.domCursor--
		}
		return nil, true
	case "down", "j":
		if d == nil {
			return nil, true
		}
		if s.netPane == 0 && s.svcCursor < len(d.Services)-1 {
			s.svcCursor++
		} else if s.netPane == 1 && s.domCursor < len(d.Ingresses)-1 {
			s.domCursor++
		}
		return nil, true
	case "a":
		if s.netPane == 0 {
			return push(newServiceForm(s.cl, s.id)), true
		}
		return push(newDomainForm(s.cl, s.domainProjectID(), s.id)), true
	case "e":
		if s.netPane != 0 || d == nil || s.svcCursor >= len(d.Services) {
			return nil, true
		}
		svc := d.Services[s.svcCursor]
		expose := !svc.public()
		verb := "exposing"
		if !expose {
			verb = "unexposing"
		}
		return doAction(s.cl, "PATCH", s.servicesPath(svc.ID)+"/exposure",
			map[string]any{"exposePublic": expose}, verb+" service "+svc.Name), true
	case "m":
		if s.netPane != 1 || d == nil || s.domCursor >= len(d.Ingresses) {
			return nil, true
		}
		return s.cycleProtection(d.Ingresses[s.domCursor]), true
	case "t":
		if !s.tsLoaded {
			return fetchTailscale(s.cl, s.id), true
		}
		if s.ts.Exposed {
			s.confirm.Show("Remove this deployment's Tailscale exposure?",
				doAction(s.cl, "POST", "/tailscale/unexpose/"+url.PathEscape(s.id), nil, "tailscale exposure removed"))
			return nil, true
		}
		return doAction(s.cl, "POST", "/tailscale/expose/"+url.PathEscape(s.id), nil, "exposing on tailscale — sidecar starting"), true
	case "x":
		if d == nil {
			return nil, true
		}
		if s.netPane == 0 && s.svcCursor < len(d.Services) {
			svc := d.Services[s.svcCursor]
			s.confirm.Show(fmt.Sprintf("Delete service %q? Its ports stop routing traffic.", svc.Name),
				doAction(s.cl, "DELETE", s.servicesPath(svc.ID), nil, "deleted service "+svc.Name))
		} else if s.netPane == 1 && s.domCursor < len(d.Ingresses) {
			ig := d.Ingresses[s.domCursor]
			pid := ig.ProjectID
			if pid == "" {
				pid = s.project.ID
			}
			s.confirm.Show(fmt.Sprintf("Delete domain %s? Traffic to it stops immediately.", ig.Host),
				doAction(s.cl, "DELETE",
					"/projects/"+url.PathEscape(pid)+"/ingresses/"+url.PathEscape(ig.ID),
					nil, "deleted "+ig.Host))
		}
		return nil, true
	}
	return nil, false
}

func (s *deploymentScreen) domainProjectID() string { return s.project.ID }

// cycleProtection steps none → orchard → password → none. Landing on password
// detours through a form for the password itself.
func (s *deploymentScreen) cycleProtection(ig DepIngress) tea.Cmd {
	pid := ig.ProjectID
	if pid == "" {
		pid = s.project.ID
	}
	path := "/projects/" + url.PathEscape(pid) + "/ingresses/" + url.PathEscape(ig.ID) + "/protection"
	switch lc(ig.ProtectionMode) {
	case "", "none":
		return doAction(s.cl, "PUT", path, map[string]any{"mode": "orchard"}, ig.Host+" protection: orchard")
	case "orchard":
		return push(newProtectionPasswordForm(s.cl, path, ig.Host))
	default: // password (or anything else) → none
		return doAction(s.cl, "PUT", path, map[string]any{"mode": "none"}, ig.Host+" protection: none")
	}
}

func (s *deploymentScreen) viewNetwork(height int, strip string) string {
	d := s.detail
	if d == nil {
		return panelRaw(strip, stMuted.Render("  no data"), s.w, height, true)
	}
	const tsH = 3
	svcH := (height - tsH) / 2
	domH := height - tsH - svcH

	svcCursor, domCursor := s.svcCursor, s.domCursor
	if s.netPane != 0 {
		svcCursor = -1
	}
	if s.netPane != 1 {
		domCursor = -1
	}

	svcRows := make([][]string, len(d.Services))
	for i, svc := range d.Services {
		exposure := stMuted.Render("internal")
		if svc.public() {
			exposure = stGreen.Render("public")
		}
		svcRows[i] = []string{svc.Name, svcPortsCell(svc), exposure, stMuted.Render(orDash(svc.Domain))}
	}
	svcBody := renderTable([]col{{title: "SERVICE"}, {title: "PORTS"}, {title: "EXPOSURE"}, {title: "DOMAIN"}},
		svcRows, svcCursor, s.w-2, svcH-2)

	domRows := make([][]string, len(d.Ingresses))
	for i, ig := range d.Ingresses {
		tls := stMuted.Render("off")
		if ig.TLSEnabled {
			tls = stGreen.Render("on")
		}
		mode := ig.ProtectionMode
		if mode == "" {
			mode = "none"
		}
		domRows[i] = []string{stLink.Render(ig.Host), orDash(ig.Path), tls, statusDot(mode)}
	}
	domBody := renderTable([]col{{title: "HOST"}, {title: "PATH"}, {title: "TLS"}, {title: "PROTECTION"}},
		domRows, domCursor, s.w-2, domH-2)

	ts := " "
	switch {
	case s.tsErr != nil:
		ts += stRed.Render("✗ " + s.tsErr.Error())
	case !s.tsLoaded:
		ts += stMuted.Render("loading…")
	case s.ts.Exposed:
		addr := s.ts.DNS
		if addr == "" {
			addr = s.ts.Hostname
		}
		if addr == "" {
			addr = s.ts.IP
		}
		ts += stGreen.Render("● exposed") + stMuted.Render(" · ") + stLink.Render(orDash(addr))
	default:
		ts += stMuted.Render("○ not exposed — press t to expose on your tailnet")
	}

	svcPanel := panelRaw(strip+stMuted.Render("   ")+stTitle.Render(fmt.Sprintf("Services (%d)", len(d.Services))),
		svcBody, s.w, svcH, s.netPane == 0)
	domPanel := panel(fmt.Sprintf("Domains (%d)", len(d.Ingresses)), domBody, s.w, domH, s.netPane == 1)
	tsPanel := panel("Tailscale", ts, s.w, tsH, false)
	return svcPanel + "\n" + domPanel + "\n" + tsPanel
}

func svcPortsCell(svc DepService) string {
	parts := make([]string, 0, len(svc.Ports))
	for _, p := range svc.Ports {
		cell := fmt.Sprintf("%d->%d", int(p.ServicePort), int(p.ContainerPort))
		if p.Protocol != "" {
			cell += "/" + p.Protocol
		}
		if p.PublicEnabled {
			if pub := int(p.PublicPort); pub > 0 {
				cell += fmt.Sprintf(" (public:%d)", pub)
			} else if np := int(p.NodePort); np > 0 {
				cell += fmt.Sprintf(" (public:%d)", np)
			} else {
				cell += " (public)"
			}
		}
		parts = append(parts, cell)
	}
	return strings.Join(parts, ", ")
}

func newServiceForm(cl *api.Client, depID string) *formScreen {
	return newForm("New service",
		"Exposes a container port inside the cluster; toggle public exposure with e afterwards.",
		[]*field{
			fld("name", "Name", "port-8080", false),
			fld("port", "Service port", "8080", true),
			fld("targetPort", "Container port", "defaults to service port", false),
			fld("protocol", "Protocol", "TCP", false),
		},
		func(v map[string]string) tea.Cmd {
			return func() tea.Msg {
				port, err := strconv.Atoi(v["port"])
				if err != nil || port <= 0 {
					return formResult{err: errInvalid("service port must be a positive number")}
				}
				target := port
				if v["targetPort"] != "" {
					if target, err = strconv.Atoi(v["targetPort"]); err != nil || target <= 0 {
						return formResult{err: errInvalid("container port must be a positive number")}
					}
				}
				proto := strings.ToUpper(v["protocol"])
				if proto == "" {
					proto = "TCP"
				}
				name := v["name"]
				if name == "" {
					name = fmt.Sprintf("port-%d", port)
				}
				body := map[string]any{
					"name":         name,
					"ports":        []any{map[string]any{"servicePort": port, "containerPort": target, "protocol": proto}},
					"exposePublic": false,
				}
				err = cl.Send(ctxBG(), "POST", "/deployments/"+url.PathEscape(depID)+"/services", body, nil)
				return formResult{ok: actionMsg{text: "created service " + name}, err: err}
			}
		})
}

func newDomainForm(cl *api.Client, projectID, depID string) *formScreen {
	return newForm("Add domain",
		"Orchard subdomains (*.a.lfdl.ink) work immediately; custom domains need a CNAME at "+ingressCNAME()+" first.",
		[]*field{
			fld("host", "Host", "app.example.com", true),
			fld("path", "Path", "/", false),
			fld("servicePort", "Service port", "80", false),
		},
		func(v map[string]string) tea.Cmd {
			path := v["path"]
			if path == "" {
				path = "/"
			}
			port := 80
			if v["servicePort"] != "" {
				n, err := strconv.Atoi(v["servicePort"])
				if err != nil || n <= 0 {
					return func() tea.Msg { return formResult{err: errInvalid("service port must be a positive number")} }
				}
				port = n
			}
			return createDomain(cl, projectID, depID, v["host"], path, port)
		})
}

func newProtectionPasswordForm(cl *api.Client, path, host string) *formScreen {
	return newForm("Password-protect "+host,
		"Visitors must enter this password before reaching the app.",
		[]*field{fld("password", "Password", "", true)},
		func(v map[string]string) tea.Cmd {
			return func() tea.Msg {
				body := map[string]any{"mode": "password", "password": v["password"]}
				err := cl.Send(ctxBG(), "PUT", path, body, nil)
				return formResult{ok: actionMsg{text: host + " protection: password"}, err: err}
			}
		})
}

package tui

import (
	"fmt"
	"net/url"

	"github.com/LeafdTK/leaf/cli/internal/api"
	tea "github.com/charmbracelet/bubbletea"
)

// Storage tab: PVC volumes. PUT /deployments/:id/volumes replaces the whole
// set, so add/remove echo the current list with the change applied
// (mirrors cmd/deploy_config.go volumes set).

func (s *deploymentScreen) storageKey(msg tea.KeyMsg) (tea.Cmd, bool) {
	d := s.detail
	switch msg.String() {
	case "up", "k":
		if s.volCursor > 0 {
			s.volCursor--
		}
		return nil, true
	case "down", "j":
		if d != nil && s.volCursor < len(d.Volumes)-1 {
			s.volCursor++
		}
		return nil, true
	case "a":
		if d == nil {
			return nil, true
		}
		return push(newVolumeForm(s.cl, s.id, d.Volumes)), true
	case "x":
		if d == nil || s.volCursor >= len(d.Volumes) {
			return nil, true
		}
		vol := d.Volumes[s.volCursor]
		rest := make([]DepVolume, 0, len(d.Volumes)-1)
		for i, v := range d.Volumes {
			if i != s.volCursor {
				rest = append(rest, v)
			}
		}
		s.confirm.Show(fmt.Sprintf("Remove volume %q (%s)? Data on it becomes unreachable.", vol.Name, vol.MountPath),
			doAction(s.cl, "PUT", "/deployments/"+url.PathEscape(s.id)+"/volumes",
				volumesBody(rest), "removed volume "+vol.Name))
		return nil, true
	}
	return nil, false
}

func (s *deploymentScreen) viewStorage(height int) string {
	d := s.detail
	if d == nil {
		return stMuted.Render("  no data")
	}
	rows := make([][]string, len(d.Volumes))
	for i, v := range d.Volumes {
		typ := v.Type
		if typ == "" {
			typ = "pvc"
		}
		ro := stMuted.Render("—")
		if v.ReadOnly {
			ro = stYellow.Render("read-only")
		}
		rows[i] = []string{v.Name, typ, v.MountPath, orDash(v.StorageSize), stMuted.Render(orDash(v.PvcName)), ro}
	}
	table := renderTable(
		[]col{{title: "NAME"}, {title: "TYPE"}, {title: "MOUNT"}, {title: "SIZE"}, {title: "PVC"}, {title: ""}},
		rows, s.volCursor, s.w-2, height-4)
	note := stMuted.Render("  PVC-backed deployments use the recreate strategy · a add · x remove")
	return table + "\n\n" + note
}

func newVolumeForm(cl *api.Client, depID string, existing []DepVolume) *formScreen {
	return newForm("Add volume",
		"Attaches a PVC at the mount path (pods roll).",
		[]*field{
			fld("mountPath", "Mount path", "/data", true),
			fld("size", "Size", "5Gi", true),
		},
		func(v map[string]string) tea.Cmd {
			return func() tea.Msg {
				name := pvcVolumeName(v["mountPath"])
				for _, e := range existing {
					if e.MountPath == v["mountPath"] || e.Name == name {
						return formResult{err: errInvalid("a volume already uses that mount path")}
					}
				}
				vols := append(append([]DepVolume{}, existing...), DepVolume{
					Name:        name,
					Type:        "pvc",
					MountPath:   v["mountPath"],
					PvcName:     name,
					StorageSize: v["size"],
				})
				err := cl.Send(ctxBG(), "PUT", "/deployments/"+url.PathEscape(depID)+"/volumes", volumesBody(vols), nil)
				return formResult{ok: actionMsg{text: "added volume " + name}, err: err}
			}
		})
}

{{/* Resolve a component image reference. */}}
{{- define "orchard.image" -}}
{{- $root := index . 0 -}}
{{- $name := index . 1 -}}
{{- $tag  := index . 2 -}}
{{- $repo := "" -}}
{{- if gt (len .) 3 -}}{{- $repo = index . 3 -}}{{- end -}}
{{- $resolvedTag := $tag | default $root.Chart.AppVersion -}}
{{- $resolvedRepo := $repo | default $root.Values.image.repository -}}
{{ printf "%s/%s/%s:%s" $root.Values.image.registry $resolvedRepo $name $resolvedTag }}
{{- end -}}

{{- define "orchard.labels" -}}
app.kubernetes.io/name: {{ .name }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/part-of: orchard
app.kubernetes.io/managed-by: helm
{{- end -}}

{{- define "orchard.pullSecrets" -}}
{{- with .Values.image.pullSecrets }}
imagePullSecrets:
{{- range . }}
  - name: {{ . }}
{{- end }}
{{- end }}
{{- end -}}

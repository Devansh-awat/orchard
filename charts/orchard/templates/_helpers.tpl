{{/* Resolve a component image reference. */}}
{{- define "orchard.image" -}}
{{- $root := index . 0 -}}
{{- $name := index . 1 -}}
{{- $tag  := index . 2 -}}
{{- $resolved := $tag | default $root.Chart.AppVersion -}}
{{ printf "%s/%s/%s:%s" $root.Values.image.registry $root.Values.image.repository $name $resolved }}
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

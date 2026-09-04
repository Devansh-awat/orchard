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

{{- define "orchard.serverEnv" }}
            - { name: NODE_ENV, value: production }
            {{- if .Values.datadog.enabled }}
            # Datadog agent service with internalTrafficPolicy: Local — each
            # pod reaches the agent on its own node. (hostPort 8126 is dead
            # here: Cilium runs without hostPort support; hostPath sockets
            # are blocked by PodSecurity baseline in this namespace.)
            # Covers traces (8126) and DogStatsD runtime metrics (8125).
            - { name: DD_AGENT_HOST, value: {{ .Values.datadog.agentHost | quote }} }
            - { name: DD_ENV, value: {{ .Values.datadog.env | quote }} }
            - { name: DD_SERVICE, value: orchard-server }
            # Unified service tagging: version tracks the deployed image tag.
            - { name: DD_VERSION, value: {{ .Values.server.image.tag | default .Chart.AppVersion | quote }} }
            {{- if not .Values.datadog.profiling }}
            - { name: DD_PROFILING_ENABLED, value: "false" }
            {{- end }}
            {{- if .Values.datadog.appsec }}
            - { name: DD_APPSEC_ENABLED, value: "true" }
            - { name: DD_API_SECURITY_ENABLED, value: "true" }
            {{- end }}
            {{- end }}
            {{- if .Values.postgres.enabled }}
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: {{ .Values.postgres.name }}-app
                  key: uri
            {{- end }}
            {{- if .Values.redis.enabled }}
            - name: REDIS_URL
              value: {{ default (printf "redis://redis.%s.svc.cluster.local:6379" .Values.namespace) .Values.redis.url | quote }}
            {{- end }}
            {{- if and .Values.builders.enabled .Values.builders.dedicatedNode.enabled }}
            - { name: BUILDER_DEDICATED_NODE, value: "true" }
            {{- end }}
            {{- if and .Values.builders.enabled .Values.builders.localCache.enabled }}
            - { name: BUILDKIT_LOCAL_CACHE_ENABLED, value: "true" }
            - { name: BUILDKIT_LOCAL_CACHE_PATH, value: {{ .Values.builders.localCache.path | quote }} }
            - { name: BUILDKIT_LOCAL_CACHE_PVC,  value: {{ .Values.builders.localCache.pvcName | quote }} }
            {{- with .Values.builders.localCache.gcKeepBytes }}
            - { name: BUILDKIT_GC_KEEP_BYTES, value: {{ . | quote }} }
            {{- end }}
            {{- with .Values.builders.localCache.gcEphemeralKeepBytes }}
            - { name: BUILDKIT_GC_EPHEMERAL_KEEP_BYTES, value: {{ . | quote }} }
            {{- end }}
            {{- with .Values.builders.localCache.evict }}
            {{- with .highPct }}
            - { name: BUILDKIT_CACHE_HIGH_PCT, value: {{ . | quote }} }
            {{- end }}
            {{- with .targetPct }}
            - { name: BUILDKIT_CACHE_TARGET_PCT, value: {{ . | quote }} }
            {{- end }}
            {{- with .maxAgeDays }}
            - { name: BUILDKIT_CACHE_MAX_AGE_DAYS, value: {{ . | quote }} }
            {{- end }}
            {{- with .idleMinutes }}
            - { name: BUILDKIT_CACHE_IDLE_MINUTES, value: {{ . | quote }} }
            {{- end }}
            {{- end }}
            {{- end }}
            {{- if .Values.tenantSandbox.enabled }}
            - { name: TENANT_RUNTIME_CLASS, value: {{ .Values.tenantSandbox.runtimeClassName | quote }} }
            {{- end }}
            {{- if .Values.builderSandbox.enabled }}
            {{- if .Values.builderSandbox.runtimeClassName }}
            - { name: BUILDER_RUNTIME_CLASS, value: {{ .Values.builderSandbox.runtimeClassName | quote }} }
            {{- end }}
            {{- if .Values.builderSandbox.depotRuntimeClassName }}
            - { name: BUILDER_DEPOT_RUNTIME_CLASS, value: {{ .Values.builderSandbox.depotRuntimeClassName | quote }} }
            {{- end }}
            {{- if .Values.builderSandbox.sidecarPush }}
            - { name: BUILDER_SIDECAR_PUSH, value: "true" }
            - { name: BUILDER_PUSHER_IMAGE, value: {{ .Values.builderSandbox.pusherImage | quote }} }
            {{- end }}
            {{- if .Values.builderSandbox.tmpfsWorkspace }}
            - { name: BUILDER_WORKSPACE_TMPFS, value: "true" }
            {{- end }}
            {{- if .Values.builderSandbox.scratch }}
            - { name: BUILDER_SCRATCH_MODE, value: {{ .Values.builderSandbox.scratch.mode | quote }} }
            - { name: BUILDER_SCRATCH_SIZE, value: {{ .Values.builderSandbox.scratch.size | quote }} }
            - { name: BUILDER_SCRATCH_STORAGE_CLASS, value: {{ .Values.builderSandbox.scratch.storageClass | quote }} }
            {{- end }}
            {{- if .Values.builderSandbox.memoryLimit }}
            - { name: BUILDER_MEMORY_LIMIT, value: {{ .Values.builderSandbox.memoryLimit | quote }} }
            {{- end }}
            {{- end }}
            {{- with .Values.sandbox }}
            {{- if .enabled }}
            - { name: SANDBOX_ENABLED, value: "true" }
            {{- if $.Values.mcp.enabled }}
            - name: SANDBOX_MCP_URL
              value: {{ printf "%s://%s" (ternary "https" "http" $.Values.mcp.ingress.tls.enabled) $.Values.mcp.ingress.host | quote }}
            {{- end }}
            - { name: SANDBOX_NAMESPACE, value: {{ .namespace | quote }} }
            - { name: SANDBOX_IMAGE, value: {{ .image | quote }} }
            {{- if .runtimeClassName }}
            - { name: SANDBOX_RUNTIME_CLASS, value: {{ .runtimeClassName | quote }} }
            {{- end }}
            - { name: SANDBOX_IDLE_TIMEOUT_MINUTES, value: {{ .idleTimeoutMinutes | quote }} }
            - { name: SANDBOX_MAX_LIFETIME_HOURS, value: {{ .maxLifetimeHours | quote }} }
            - { name: SANDBOX_MAX_PER_USER, value: {{ .maxPerUserDefault | quote }} }
            - { name: SANDBOX_STORAGE_CLASS, value: {{ .storageClass | quote }} }
            - { name: SANDBOX_DISK_SIZE, value: {{ .diskSize | quote }} }
            - { name: SANDBOX_CPU_LIMIT, value: {{ .cpuLimit | quote }} }
            - { name: SANDBOX_MEMORY_LIMIT, value: {{ .memoryLimit | quote }} }
            {{- if .tunnelMode }}
            - { name: SANDBOX_TUNNEL_MODE, value: {{ .tunnelMode | quote }} }
            {{- end }}
            {{- if .homeMode }}
            - { name: SANDBOX_HOME_MODE, value: {{ .homeMode | quote }} }
            {{- end }}
            {{- end }}
            {{- end }}
            {{- if .Values.r2Proxy.enabled }}
            - { name: BACKUP_PROXY_ENABLED, value: "true" }
            - name: BACKUP_PROXY_ENDPOINT
              value: {{ default (printf "http://r2-proxy.%s.svc.cluster.local:9000" .Values.r2Proxy.namespace) .Values.r2Proxy.serviceUrl | quote }}
            {{- end }}
            {{- with .Values.publicTls }}
            {{- if .db }}
            - name: PUBLIC_DB_TLS_SOURCE_NAMESPACE
              value: {{ .db.sourceNamespace | default $.Values.certificates.namespace | quote }}
            - name: PUBLIC_DB_TLS_SOURCE_SECRET
              value: {{ .db.sourceSecret | default $.Values.certificates.wildcards.db.secretName | quote }}
            - name: PUBLIC_DB_TLS_LOCAL_SECRET
              value: {{ .db.localSecret | quote }}
            {{- end }}
            {{- end }}
            {{- if .Values.signupMode }}
            - { name: SIGNUP_MODE, value: {{ .Values.signupMode | quote }} }
            {{- end }}
            {{- with .Values.tenant }}
            {{- if .storageClass }}
            - { name: K8S_STORAGE_CLASS, value: {{ .storageClass | quote }} }
            {{- end }}
            {{- if .ingressClass }}
            - { name: K8S_INGRESS_CLASS, value: {{ .ingressClass | quote }} }
            {{- end }}
            {{- if .certClusterIssuer }}
            - { name: CERT_CLUSTER_ISSUER, value: {{ .certClusterIssuer | quote }} }
            {{- end }}
            {{- if .wildcardDomains }}
            - { name: PLATFORM_WILDCARD_DOMAINS, value: {{ .wildcardDomains | quote }} }
            {{- end }}
            {{- end }}
            {{- with .Values.server.env }}
            {{- toYaml . | nindent 12 }}
            {{- end }}
{{- end }}

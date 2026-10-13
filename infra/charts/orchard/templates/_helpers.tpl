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

{{/*
Wildcard suffix=tlsSecret pairs the server builds generated app URLs from.
Explicit tenant.wildcardDomains wins; otherwise derive a single entry from the
app domain the gateway already terminates TLS for, so operators configure the
domain once instead of keeping four values in sync.
*/}}
{{- define "orchard.appWildcardSecret" -}}
{{- if .Values.gateway.http.appWildcardSecretName -}}
{{- .Values.gateway.http.appWildcardSecretName -}}
{{- else if .Values.gateway.http.appDomain -}}
{{- printf "wildcard-%s-tls" (regexReplaceAll "[^a-zA-Z0-9]+" .Values.gateway.http.appDomain "-") -}}
{{- end -}}
{{- end -}}

{{- define "orchard.wildcardDomains" -}}
{{- if .Values.tenant.wildcardDomains -}}
{{ .Values.tenant.wildcardDomains }}
{{- else if .Values.gateway.http.appDomain -}}
{{- /*
  Suffix only, with no `=secret`, unless a wildcard Secret was actually named.
  Naming a derived one made every generated URL reference a Secret that nothing
  on a stock install creates, so the host served no certificate. Without it the
  server issues per-host against tenant.certClusterIssuer, which works with no
  extra setup.
*/ -}}
{{- if .Values.gateway.http.appWildcardSecretName -}}
{{ printf ".%s=%s" .Values.gateway.http.appDomain .Values.gateway.http.appWildcardSecretName }}
{{- else -}}
{{ printf ".%s" .Values.gateway.http.appDomain }}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* The app domain the server generates hostnames under. */}}
{{- define "orchard.appDomain" -}}
{{- .Values.gateway.http.appDomain | default "" -}}
{{- end -}}

{{/* True when server.env already defines `key`, so the chart shouldn't. */}}
{{- define "orchard.serverEnvHas" -}}
{{- $key := .key -}}
{{- range .root.Values.server.env -}}
{{- if eq .name $key }}found{{ end -}}
{{- end -}}
{{- end -}}

{{/* The same question for any env list: pass `env` and `key`. */}}
{{- define "orchard.envHas" -}}
{{- $key := .key -}}
{{- range .env -}}
{{- if eq .name $key }}found{{ end -}}
{{- end -}}
{{- end -}}

{{/*
The public origin of the Orchard UI. An explicit server.env FRONTEND_URL wins,
because it is the one the server itself signs callbacks against, and it is not
always derivable: behind a tunnel the route terminates plaintext in-cluster
while the world reaches it over https.
*/}}
{{- define "orchard.frontendUrl" -}}
{{- $set := "" -}}
{{- range .Values.server.env -}}
{{- if eq .name "FRONTEND_URL" }}{{ $set = .value }}{{ end -}}
{{- end -}}
{{- if $set -}}
{{- $set -}}
{{- else if and .Values.ingress.enabled .Values.ingress.host -}}
{{- printf "%s://%s" (ternary "https" "http" .Values.ingress.tls.enabled) .Values.ingress.host -}}
{{- end -}}
{{- end -}}

{{/*
Where the MCP answers. Empty unless it is enabled and its route has a host,
so nothing derives a URL like "https://" from an unset hostname.
*/}}
{{- define "orchard.mcpUrl" -}}
{{- if .Values.mcp.enabled -}}
{{- if .Values.mcp.url -}}
{{- .Values.mcp.url -}}
{{- else if and .Values.mcp.ingress.enabled .Values.mcp.ingress.host -}}
{{- printf "%s://%s" (ternary "https" "http" .Values.mcp.ingress.tls.enabled) .Values.mcp.ingress.host -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* The Secret the MCP IngressRoute terminates with, mirroring the UI's. */}}
{{- define "orchard.mcpTlsSecret" -}}
{{- $tls := .Values.mcp.ingress.tls -}}
{{- if $tls.secretName -}}
{{- $tls.secretName -}}
{{- else if (($tls.issuerRef | default dict).name) -}}
{{- printf "%s-mcp-tls" .Release.Name -}}
{{- end -}}
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

{{/*
The Secret the control-plane IngressRoute terminates TLS with. Explicit
secretName wins; otherwise it is only defaulted when the chart is the one
issuing the certificate, so an install that fills the Secret in out of band
still has to name it.
*/}}
{{- define "orchard.sandboxInstalled" -}}
{{- $s := .Values.sandbox -}}
{{- if kindIs "invalid" $s.install -}}
{{- if $s.enabled }}true{{ end -}}
{{- else if $s.install -}}
true
{{- end -}}
{{- end }}

{{- define "orchard.sandboxIngressPorts" -}}
{{- list 22 4096 3000 3001 4173 5173 8000 8080 8787 | toJson -}}
{{- end }}

{{- define "orchard.ingressTlsSecret" -}}
{{- $tls := .Values.ingress.tls -}}
{{- if $tls.secretName -}}
{{- $tls.secretName -}}
{{- else if (($tls.issuerRef | default dict).name) -}}
{{- printf "%s-tls" .Release.Name -}}
{{- end -}}
{{- end }}

{{- define "orchard.serverEnv" }}
            - { name: NODE_ENV, value: production }
            - { name: TENANT_SECRETS_CLUSTER_ROLE, value: {{ printf "%s-tenant-secrets" .Release.Name | quote }} }
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
            - name: POD_IP
              valueFrom:
                fieldRef:
                  fieldPath: status.podIP
            {{- if and .Values.builders.enabled .Values.builders.dedicatedNode.enabled }}
            - { name: BUILDER_DEDICATED_NODE, value: "true" }
            {{- end }}
            {{- with .Values.builders.platform }}
            - { name: BUILD_PLATFORM, value: {{ . | quote }} }
            {{- end }}
            {{- if .Values.protection.orchardLogin }}
            - { name: PROTECTION_ORCHARD_LOGIN, value: "true" }
            {{- end }}
            {{- if .Values.certificates.copyToTenants }}
            # Where the wildcard TLS Secret is issued. The server copies it into
            # every namespace whose ingresses name it, because a wildcard is
            # issued once but referenced locally by each tenant Ingress.
            #
            # Opt-in, and it must stay off wherever something else already does
            # this: two controllers replacing the same Secret would each undo
            # the other's metadata and rewrite forever.
            - { name: WILDCARD_TLS_SOURCE_NAMESPACE, value: {{ .Values.certificates.namespace | quote }} }
            {{- end }}
            {{- if .Values.cilium.enabled }}
            # Only set when the operator opts in. Left unset the server probes
            # the cluster for the cilium.io group plus create permission on
            # ciliumenvoyconfigs, so an install that already runs Cilium keeps
            # its basic-auth and per-tenant policy without touching values.
            - { name: CILIUM_ENABLED, value: "true" }
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
            {{- if .Values.tenant.ingressNamespaces }}
            - { name: TENANT_INGRESS_NAMESPACES, value: {{ .Values.tenant.ingressNamespaces | quote }} }
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
            {{- if include "orchard.sandboxInstalled" $ }}
            - { name: ORCHARD_SERVER_NAMESPACE, value: {{ $.Values.namespace | quote }} }
            {{- with (include "orchard.mcpUrl" $) }}
            - { name: SANDBOX_MCP_URL, value: {{ . | quote }} }
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
            {{- with .runners }}
            {{- if not (kindIs "invalid" .kubernetes.enabled) }}
            - { name: SANDBOX_RUNNER_KUBERNETES_ENABLED, value: {{ .kubernetes.enabled | toString | quote }} }
            {{- end }}
            {{- if not (kindIs "invalid" .vercel.enabled) }}
            - { name: SANDBOX_RUNNER_VERCEL_ENABLED, value: {{ .vercel.enabled | toString | quote }} }
            {{- end }}
            {{- if .default }}
            - { name: SANDBOX_DEFAULT_RUNNER, value: {{ .default | quote }} }
            {{- end }}
            {{- with .vercel }}
            {{- if .tokenSecret.name }}
            - name: SANDBOX_VERCEL_TOKEN
              valueFrom:
                secretKeyRef:
                  name: {{ .tokenSecret.name | quote }}
                  key: {{ .tokenSecret.key | default "token" | quote }}
            {{- end }}
            {{- if .teamId }}
            - { name: SANDBOX_VERCEL_TEAM_ID, value: {{ .teamId | quote }} }
            {{- end }}
            {{- if .projectId }}
            - { name: SANDBOX_VERCEL_PROJECT_ID, value: {{ .projectId | quote }} }
            {{- end }}
            {{- if .image }}
            - { name: SANDBOX_VERCEL_IMAGE, value: {{ .image | quote }} }
            {{- end }}
            {{- if .vcpus }}
            - { name: SANDBOX_VERCEL_VCPUS, value: {{ .vcpus | toString | quote }} }
            {{- end }}
            {{- if .timeoutMinutes }}
            - { name: SANDBOX_VERCEL_TIMEOUT_MINUTES, value: {{ .timeoutMinutes | toString | quote }} }
            {{- end }}
            {{- if ne (toString (.driveGiB | default "")) "" }}
            - { name: SANDBOX_VERCEL_DRIVE_GIB, value: {{ .driveGiB | toString | quote }} }
            {{- end }}
            {{- end }}
            {{- if .bridgeBinaryUrl }}
            - { name: SANDBOX_BRIDGE_BINARY_URL, value: {{ .bridgeBinaryUrl | quote }} }
            {{- end }}
            {{- if .bridgeBinarySha256 }}
            - { name: SANDBOX_BRIDGE_BINARY_SHA256, value: {{ .bridgeBinarySha256 | quote }} }
            {{- end }}
            {{- if .previewDomain }}
            - { name: SANDBOX_PREVIEW_DOMAIN, value: {{ .previewDomain | quote }} }
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
            {{- if not .Values.mcp.enabled }}
            # Nothing is serving MCP on this instance, so the runtime toggle is
            # pinned off rather than left switchable from the admin panel.
            - { name: MCP_ENABLED, value: "false" }
            {{- end }}
            {{- /*
              The server needs the MCP's hostname too, not to serve it, but to
              report on it: the DNS check in the admin panel cannot tell an
              operator that mcp.example.com does not resolve without knowing it
              is supposed to.
            */}}
            {{- if not (or (include "orchard.serverEnvHas" (dict "root" . "key" "MCP_BASE_URL")) .Values.server.envFrom) }}
            {{- with (include "orchard.mcpUrl" .) }}
            - { name: MCP_BASE_URL, value: {{ . | quote }} }
            {{- end }}
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
            {{- if .publicIp }}
            - { name: PUBLIC_EXPOSURE_IP, value: {{ .publicIp | quote }} }
            {{- end }}
            {{- end }}
            {{- with (include "orchard.wildcardDomains" .) }}
            - { name: PLATFORM_WILDCARD_DOMAINS, value: {{ . | quote }} }
            {{- end }}
            {{- /*
              APP_DOMAIN is only injected when the operator hasn't supplied it
              themselves. A container `env` entry outranks every `envFrom`
              source, so emitting it unconditionally would silently shadow an
              APP_DOMAIN held in a Secret — which is how the kubeops install
              provides it.
            */}}
            {{- if not (or (include "orchard.serverEnvHas" (dict "root" . "key" "APP_DOMAIN")) .Values.server.envFrom) }}
            {{- with (include "orchard.appDomain" .) }}
            - { name: APP_DOMAIN, value: {{ . | quote }} }
            {{- end }}
            {{- end }}
            {{- with .Values.server.env }}
            {{- toYaml . | nindent 12 }}
            {{- end }}
{{- end }}

{{/*
One password for the proxy's postgres role, stable across upgrades: an
explicit value wins, then whatever the secret already holds, then a fresh
random one that every template in this render sees.
*/}}
{{- define "orchard.r2ProxyDbPassword" -}}
{{- if .Values.r2Proxy.databasePassword -}}
{{- .Values.r2Proxy.databasePassword -}}
{{- else -}}
{{- $existing := (lookup "v1" "Secret" .Values.namespace "orchard-r2-proxy-db") -}}
{{- if and $existing $existing.data $existing.data.password -}}
{{- $existing.data.password | b64dec -}}
{{- else -}}
{{- if not (index .Values.r2Proxy "generatedDatabasePassword") -}}
{{- $_ := set .Values.r2Proxy "generatedDatabasePassword" (randAlphaNum 40) -}}
{{- end -}}
{{- index .Values.r2Proxy "generatedDatabasePassword" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "orchard.graftsOn" -}}
{{- if gt (len (default (list) .Values.grafts)) 0 }}true{{- end }}
{{- end }}

{{- define "orchard.graftEnv" }}
            - { name: ORCHARD_GRAFTS_DIR, value: /app/grafts }
            - { name: ORCHARD_GRAFTS, value: {{ toJson (default (list) .Values.grafts) | quote }} }
            - { name: ORCHARD_GRAFT_TRUST, value: {{ .Values.graftSettings.trust | default "signed" | quote }} }
            {{- with .Values.graftSettings.keys }}
            - { name: ORCHARD_GRAFT_KEYS, value: {{ join "," . | quote }} }
            {{- end }}
            {{- with .Values.graftSettings.marketplaceUrl }}
            - { name: ORCHARD_GRAFT_MARKETPLACE_URL, value: {{ . | quote }} }
            {{- end }}
            {{- if .Values.graftSettings.strict }}
            - { name: ORCHARD_GRAFTS_STRICT, value: "true" }
            {{- end }}
            {{- if .Values.graftSettings.safeMode }}
            - { name: ORCHARD_GRAFTS_SAFE_MODE, value: "true" }
            {{- end }}
            {{- with .Values.graftSettings.pools }}
            - { name: ORCHARD_GRAFT_POOLS, value: {{ toJson . | quote }} }
            {{- end }}
            - { name: ORCHARD_DB_SERVER_PODS, value: {{ ternary .Values.server.autoscaling.maxReplicas .Values.server.replicas .Values.server.autoscaling.enabled | toString | quote }} }
            {{- if .Values.server.workers.enabled }}
            - { name: ORCHARD_DB_WORKER_PODS, value: {{ ternary .Values.server.workers.autoscaling.maxReplicas .Values.server.workers.replicas .Values.server.workers.autoscaling.enabled | toString | quote }} }
            {{- end }}
{{- end }}

{{- define "orchard.graftAnnotations" }}
      annotations:
        orchard.my/grafts: {{ toJson (list (default (list) .Values.grafts) .Values.graftSettings) | sha256sum | quote }}
{{- end }}

{{- define "orchard.graftInit" }}
      initContainers:
        - name: graft-sync
          image: {{ include "orchard.image" (list . .Values.server.image.name .Values.server.image.tag) }}
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          workingDir: /app/apps/server
          command: ["node", "dist/scripts/graft-sync.js"]
          env:{{ include "orchard.graftEnv" . }}
            {{- if .Values.postgres.enabled }}
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: {{ .Values.postgres.name }}-app
                  key: uri
            {{- else if (include "orchard.serverEnvHas" (dict "root" . "key" "DATABASE_URL")) }}
            {{- range .Values.server.env }}
            {{- if eq .name "DATABASE_URL" }}
            - {{ toJson . }}
            {{- end }}
            {{- end }}
            {{- end }}
          volumeMounts:
            - { name: grafts, mountPath: /app/grafts }
          resources:
            requests: { cpu: 50m, memory: 128Mi }
            limits: { memory: 512Mi }
{{- end }}

{{- define "orchard.graftMount" }}
          volumeMounts:
            - { name: grafts, mountPath: /app/grafts, readOnly: true }
{{- end }}

{{- define "orchard.graftVolume" }}
      volumes:
        - name: grafts
          emptyDir: { sizeLimit: 2Gi }
{{- end }}

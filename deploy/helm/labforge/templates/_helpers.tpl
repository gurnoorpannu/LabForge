{{/* Labels on every object. */}}
{{- define "labforge.labels" -}}
app.kubernetes.io/name: labforge
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end }}

{{/* Selector for one component: include "labforge.selector" (dict "component" "api") */}}
{{- define "labforge.selector" -}}
app.kubernetes.io/name: labforge
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{/* Image ref: include "labforge.image" (dict "root" $ "name" .Values.images.api) */}}
{{- define "labforge.image" -}}
{{- $reg := .root.Values.images.registry -}}
{{- if $reg }}{{ $reg }}/{{ end }}{{ .name }}:{{ .root.Values.images.tag }}
{{- end }}

{{/* Pod-level security: what the `restricted` Pod Security profile requires. */}}
{{- define "labforge.podSecurity" -}}
runAsNonRoot: true
runAsUser: {{ .uid | default 1000 }}
runAsGroup: {{ .uid | default 1000 }}
fsGroup: {{ .uid | default 1000 }}
seccompProfile:
  type: RuntimeDefault
{{- end }}

{{- define "labforge.containerSecurity" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: ["ALL"]
{{- end }}

{{/* Database env for every component (DATABASE_URL is built from the Secret). */}}
{{- define "labforge.dbEnv" -}}
- name: POSTGRES_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ .Values.postgres.existingSecret }}
      key: POSTGRES_PASSWORD
- name: DATABASE_URL
  value: "postgres://labforge:$(POSTGRES_PASSWORD)@labforge-postgres:5432/labforge"
{{- end }}

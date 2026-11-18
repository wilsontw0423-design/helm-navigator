{{/* Called with .Values.image: `.` is the image map */}}
{{- define "child.image" -}}
{{ .repository }}:{{ .tag }}
{{- end }}

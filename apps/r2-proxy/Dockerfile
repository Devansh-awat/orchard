FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY main.go ./
ARG VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X main.Version=${VERSION}" -o /out/r2-proxy .

FROM gcr.io/distroless/static-debian12:nonroot
LABEL org.opencontainers.image.source="https://github.com/hackclub/orchard"
COPY --from=build /out/r2-proxy /r2-proxy
COPY THIRD_PARTY_NOTICES.txt /THIRD_PARTY_NOTICES.txt
EXPOSE 9000
USER nonroot:nonroot
ENTRYPOINT ["/r2-proxy"]

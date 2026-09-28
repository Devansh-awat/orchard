FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
ARG VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X main.Version=${VERSION}" -o /out/registry .

FROM gcr.io/distroless/static-debian12:nonroot
LABEL org.opencontainers.image.source="https://github.com/hackclub/orchard"
COPY --from=build /out/registry /registry
COPY THIRD_PARTY_NOTICES.txt /THIRD_PARTY_NOTICES.txt
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/registry"]

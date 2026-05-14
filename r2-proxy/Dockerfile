FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY main.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/r2-proxy .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/r2-proxy /r2-proxy
EXPOSE 9000
USER nonroot:nonroot
ENTRYPOINT ["/r2-proxy"]

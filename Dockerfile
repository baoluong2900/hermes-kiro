# builder 阶段始终运行在构建机原生平台（amd64），用 Go 交叉编译目标平台二进制
FROM --platform=$BUILDPLATFORM golang:1.23-alpine AS builder

ARG TARGETOS
ARG TARGETARCH

WORKDIR /app
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download

COPY . .
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -o kiro-go .

FROM cloudflare/cloudflared:2026.10.7@sha256:4955524aeaa379e154023d5a027c250f7b35041a2e7e950cf13f144bc9b9c5ba AS cloudflared

FROM alpine:latest
RUN apk --no-cache add bash ca-certificates

WORKDIR /app
COPY --from=cloudflared /usr/local/bin/cloudflared /usr/local/bin/cloudflared
COPY --chmod=755 deploy/docker/entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY --from=builder /app/kiro-go .
COPY --from=builder /app/web ./web
RUN mkdir -p /app/data

EXPOSE 8080
VOLUME /app/data

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["./kiro-go"]

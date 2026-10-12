package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"infinite-canvas/backend/internal/novaibridge"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if err := run(ctx); err != nil {
		log.Fatal(err)
	}
}

func run(ctx context.Context) error {
	capacity := 32
	if value := os.Getenv("HOVAITV_MAX_OPEN_WORKSPACES"); value != "" {
		parsed, err := strconv.Atoi(value)
		if err != nil || parsed <= 0 {
			return errors.New("HOVAITV_MAX_OPEN_WORKSPACES must be a positive integer")
		}
		capacity = parsed
	}
	bridge, err := novaibridge.NewServer(novaibridge.ServerOptions{
		DataDir: environment("HOVAITV_DATA_DIR", "/data/users"), GatewayURL: environment("NOVAI_GATEWAY_URL", "http://api:8080"),
		BridgeSecret: os.Getenv("HOVAITV_BRIDGE_SECRET"), MaxWorkspaces: capacity,
	})
	if err != nil {
		return err
	}
	server := &http.Server{Addr: environment("HOVAITV_LISTEN_ADDR", environment("HOVAITV_ADDR", ":8090")), Handler: bridge, ReadHeaderTimeout: 10 * time.Second}
	failure := make(chan error, 1)
	go func() { failure <- server.ListenAndServe() }()
	log.Printf("HovAITV platform bridge listening on %s", server.Addr)
	var serveErr error
	select {
	case <-ctx.Done():
	case serveErr = <-failure:
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	shutdownErr := server.Shutdown(shutdown)
	if shutdownErr != nil {
		_ = server.Close()
	}
	if errors.Is(serveErr, http.ErrServerClosed) {
		serveErr = nil
	}
	return errors.Join(serveErr, shutdownErr, bridge.Close(shutdown))
}

func environment(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

package novaibridge

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"infinite-canvas/backend/internal/bootstrap"

	"github.com/google/uuid"
)

type ServerOptions struct {
	DataDir       string
	GatewayURL    string
	BridgeSecret  string
	MaxWorkspaces int
}

type accountRuntime struct {
	entryMu sync.Mutex
	runtime *bootstrap.Runtime
	client  *Client
}

type Server struct {
	options  ServerOptions
	mu       sync.Mutex
	accounts map[string]*accountRuntime
	closed   bool
}

func NewServer(options ServerOptions) (*Server, error) {
	if options.MaxWorkspaces <= 0 {
		options.MaxWorkspaces = 32
	}
	if !filepath.IsAbs(options.DataDir) || len(options.BridgeSecret) < 32 {
		return nil, errors.New("platform bridge requires an absolute data directory and a strong bridge secret")
	}
	if _, err := NewClient(options.GatewayURL, options.BridgeSecret, "startup-validation", "startup-validation"); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(options.DataDir, 0o700); err != nil {
		return nil, err
	}
	return &Server{options: options, accounts: map[string]*accountRuntime{}}, nil
}

func validIdentity(userID, version string) bool {
	id, err := uuid.Parse(userID)
	return err == nil && id != uuid.Nil && id.String() == userID && version != "" && len(version) <= 256 && strings.TrimSpace(version) == version && !strings.ContainsAny(version, "\r\n\x00")
}

func (s *Server) account(userID, version string) (*accountRuntime, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil, errors.New("platform bridge is draining")
	}
	if existing := s.accounts[userID]; existing != nil {
		existing.client.SetCredentialVersion(version)
		return existing, nil
	}
	if len(s.accounts) >= s.options.MaxWorkspaces {
		return nil, errors.New("platform workspace capacity reached")
	}
	dataDir := filepath.Join(s.options.DataDir, userID)
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, err
	}
	info, err := os.Lstat(dataDir)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("invalid platform workspace directory")
	}
	client, err := NewClient(s.options.GatewayURL, s.options.BridgeSecret, userID, version)
	if err != nil {
		return nil, err
	}
	config, err := NewConfig(client, dataDir)
	if err != nil {
		return nil, err
	}
	runtime, err := bootstrap.Open(context.Background(), bootstrap.Config{
		Profile: bootstrap.ProfileServer, DataDir: dataDir, ListenAddr: "127.0.0.1:0",
		AutoMigrate: true, ShutdownTimeout: 30 * time.Second, ProviderConfig: config, ModelProvider: client,
	})
	if err != nil {
		return nil, err
	}
	if err := runtime.Start(); err != nil {
		_ = runtime.Close(context.Background())
		return nil, err
	}
	account := &accountRuntime{runtime: runtime, client: client}
	s.accounts[userID] = account
	return account, nil
}

func bridgeFailure(writer http.ResponseWriter, status int, message string) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(map[string]any{"code": status, "data": nil, "msg": message})
}

func (s *Server) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	if (request.URL.Path == "/health/ready" || request.URL.Path == "/api/health/ready") && (request.Method == http.MethodGet || request.Method == http.MethodHead) {
		s.mu.Lock()
		closed := s.closed
		s.mu.Unlock()
		if closed {
			bridgeFailure(writer, http.StatusServiceUnavailable, "platform bridge is draining")
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		if request.Method == http.MethodHead {
			writer.WriteHeader(http.StatusOK)
			return
		}
		_, _ = writer.Write([]byte(`{"code":0,"data":{"ready":true},"msg":"ok"}`))
		return
	}
	if subtle.ConstantTimeCompare([]byte(request.Header.Get("X-Novai-Bridge-Secret")), []byte(s.options.BridgeSecret)) != 1 {
		bridgeFailure(writer, http.StatusUnauthorized, "trusted platform gateway required")
		return
	}
	userID := request.Header.Get("X-Novai-User-ID")
	version := request.Header.Get("X-Novai-Credential-Version")
	if !validIdentity(userID, version) {
		bridgeFailure(writer, http.StatusUnauthorized, "invalid platform identity")
		return
	}
	if !strings.HasPrefix(request.URL.Path, "/api/") {
		bridgeFailure(writer, http.StatusNotFound, "request does not exist")
		return
	}
	account, err := s.account(userID, version)
	if err != nil {
		bridgeFailure(writer, http.StatusServiceUnavailable, "workspace temporarily unavailable")
		return
	}
	if request.URL.Path == "/api/platform/canvas-entry" {
		if request.Method != http.MethodPost {
			bridgeFailure(writer, http.StatusMethodNotAllowed, "POST required")
			return
		}
		var input struct {
			ID    string `json:"id"`
			Title string `json:"title"`
		}
		if json.NewDecoder(http.MaxBytesReader(writer, request.Body, 4096)).Decode(&input) != nil || !validIdentity(input.ID, "project") || strings.TrimSpace(input.Title) == "" || len(input.Title) > 1024 {
			bridgeFailure(writer, http.StatusBadRequest, "invalid platform project")
			return
		}
		account.entryMu.Lock()
		err := account.runtime.EnsurePlatformCanvas(input.ID, input.Title)
		account.entryMu.Unlock()
		if err != nil {
			bridgeFailure(writer, http.StatusServiceUnavailable, "canvas entry unavailable")
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(map[string]any{"code": 0, "data": map[string]string{"id": input.ID}, "msg": "ok"})
		return
	}
	// Authentication terminates here. Original HovAITV handlers receive the
	// original route, body and stream contract under a fixed local workspace.
	forward := request.Clone(request.Context())
	forward.Header.Del("X-Novai-Bridge-Secret")
	forward.Header.Del("X-Novai-User-ID")
	forward.Header.Del("X-Novai-Credential-Version")
	account.runtime.Handler().ServeHTTP(writer, forward)
}

func (s *Server) Close(ctx context.Context) error {
	s.mu.Lock()
	s.closed = true
	accounts := make([]*accountRuntime, 0, len(s.accounts))
	for _, account := range s.accounts {
		accounts = append(accounts, account)
	}
	s.mu.Unlock()
	var failures []error
	for _, account := range accounts {
		if err := account.runtime.Close(ctx); err != nil {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}

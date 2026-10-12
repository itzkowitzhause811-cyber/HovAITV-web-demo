package novaibridge

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

const secondTestUserID = "22222222-2222-4222-8222-222222222222"

func platformRequest(t *testing.T, server *Server, userID, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var data []byte
	if body != nil {
		var err error
		data, err = json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
	}
	request := httptest.NewRequest(method, path, bytes.NewReader(data))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Novai-Bridge-Secret", testBridgeSecret)
	request.Header.Set("X-Novai-User-ID", userID)
	request.Header.Set("X-Novai-Credential-Version", "v1")
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	return response
}

func decodeData(t *testing.T, response *httptest.ResponseRecorder, target any) {
	t.Helper()
	if response.Code != http.StatusOK {
		t.Fatalf("original API failed: %d %s", response.Code, response.Body.String())
	}
	var envelope struct {
		Code int             `json:"code"`
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil || envelope.Code != 0 {
		t.Fatalf("invalid original API response: %s", response.Body.String())
	}
	if err := json.Unmarshal(envelope.Data, target); err != nil {
		t.Fatal(err)
	}
}

func TestPlatformOriginalRuntimeIsolationAndTextExecution(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	captured := make(chan map[string]any, 1)
	release := make(chan struct{})
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	gateway := fakeGateway(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != compatPath("text")+"/chat/completions" || r.Header.Get("Authorization") != "Bearer ephemeral-test-token" {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		var body map[string]any
		if json.NewDecoder(r.Body).Decode(&body) != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		captured <- body
		<-release
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"original text result"},"finish_reason":"stop"}]}`))
	})
	defer gateway.Close()
	root := t.TempDir()
	server, err := NewServer(ServerOptions{DataDir: root, GatewayURL: gateway.URL, BridgeSecret: testBridgeSecret})
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := server.Close(context.Background()); err != nil {
			t.Error(err)
		}
	}()
	defer unblock()
	var created struct {
		Project struct {
			ID string `json:"id"`
		} `json:"project"`
	}
	decodeData(t, platformRequest(t, server, testUserID, http.MethodPost, "/api/projects", map[string]any{"name": "Account One Project", "type": "short_drama"}), &created)
	if created.Project.ID == "" {
		t.Fatal("original project was not created")
	}
	var others struct {
		Projects []any `json:"projects"`
	}
	decodeData(t, platformRequest(t, server, secondTestUserID, http.MethodGet, "/api/projects", nil), &others)
	if len(others.Projects) != 0 {
		t.Fatal("account project lists were mixed")
	}
	if response := platformRequest(t, server, secondTestUserID, http.MethodGet, "/api/projects/"+created.Project.ID, nil); response.Code == http.StatusOK {
		t.Fatal("another account could read the original project")
	}
	for _, userID := range []string{testUserID, secondTestUserID} {
		if _, err := os.Stat(filepath.Join(root, userID, "open_ai_canvas.db")); err != nil {
			t.Fatal("each account must retain its own original SQLite store")
		}
	}
	input := map[string]any{"mode": "text", "prompt": "my exact ordinary question", "textHistory": []any{map[string]any{"role": "user", "content": "earlier question"}, map[string]any{"role": "assistant", "content": "earlier answer"}},
		"config": map[string]any{"model": "text-test", "credentialRef": testCatalog(testUserID, "v1").CredentialRef, "systemPrompt": "my original system prompt", "apiKey": "must-not-persist", "interfaceType": "wrong-protocol", "baseUrl": "https://attacker.example"}}
	before := cloneForTest(t, input)
	var task model.Task
	decodeData(t, platformRequest(t, server, testUserID, http.MethodPost, "/api/tasks", map[string]any{"type": "canvas_text", "prompt": "my exact ordinary question", "model": "text-test", "input": input}), &task)
	if !reflect.DeepEqual(input, before) {
		t.Fatal("API adaptation changed original caller payload")
	}
	db, err := gorm.Open(sqlite.Open(filepath.Join(root, testUserID, "open_ai_canvas.db")), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := db.DB()
	defer sqlDB.Close()
	var persisted model.Task
	if err := db.First(&persisted, "id = ?", task.ID).Error; err != nil {
		t.Fatal(err)
	}
	var persistedInput map[string]any
	if err := json.Unmarshal([]byte(persisted.InputJSON), &persistedInput); err != nil {
		t.Fatal(err)
	}
	if persistedInput["prompt"] != before["prompt"] || !reflect.DeepEqual(persistedInput["textHistory"], before["textHistory"]) {
		t.Fatal("the queued original text input was changed")
	}
	for _, secret := range []string{"ephemeral-test-token", "must-not-persist", testBridgeSecret} {
		if strings.Contains(persisted.InputJSON, secret) {
			t.Fatal("transport credential entered the queued snapshot")
		}
	}
	unblock()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		decodeData(t, platformRequest(t, server, testUserID, http.MethodGet, "/api/tasks/"+task.ID, nil), &task)
		if task.Status == model.TaskStatusSucceeded || task.Status == model.TaskStatusFailed {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if task.Status != model.TaskStatusSucceeded || !strings.Contains(task.ResultJSON, "original text result") {
		t.Fatalf("original worker/text stream failed: status=%s error=%s result=%s", task.Status, task.Error, task.ResultJSON)
	}
	select {
	case body := <-captured:
		expected := []any{map[string]any{"role": "system", "content": "my original system prompt"}, map[string]any{"role": "user", "content": "earlier question"}, map[string]any{"role": "assistant", "content": "earlier answer"}, map[string]any{"role": "user", "content": "my exact ordinary question"}}
		if !reflect.DeepEqual(body["messages"], expected) || body["model"] != "text-test" {
			t.Fatalf("original provider messages were altered: %#v", body)
		}
	default:
		t.Fatal("original provider was never called")
	}
	events := platformRequest(t, server, testUserID, http.MethodGet, "/api/tasks/"+task.ID+"/text-events", nil)
	if events.Code != http.StatusOK || !strings.Contains(events.Header().Get("Content-Type"), "text/event-stream") || !strings.Contains(events.Body.String(), "original text result") {
		t.Fatalf("original task SSE did not replay the result: %d %s", events.Code, events.Body.String())
	}
	if err := db.First(&persisted, "id = ?", task.ID).Error; err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"ephemeral-test-token", "must-not-persist", testBridgeSecret} {
		if strings.Contains(persisted.InputJSON, secret) || strings.Contains(persisted.ResultJSON, secret) {
			t.Fatal("transport credential entered persistent task data")
		}
	}
	if response := platformRequest(t, server, secondTestUserID, http.MethodGet, "/api/tasks/"+task.ID, nil); response.Code == http.StatusOK {
		t.Fatal("another account could read the task")
	}
}

func TestPlatformRejectsUntrustedIdentityBeforeOpeningWorkspace(t *testing.T) {
	gateway := fakeGateway(t, nil)
	defer gateway.Close()
	server, err := NewServer(ServerOptions{DataDir: t.TempDir(), GatewayURL: gateway.URL, BridgeSecret: testBridgeSecret})
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close(context.Background())
	for _, userID := range []string{"", "../outside", "00000000-0000-0000-0000-000000000000", "not-a-uuid"} {
		if response := platformRequest(t, server, userID, http.MethodGet, "/api/projects", nil); response.Code != http.StatusUnauthorized {
			t.Fatal("invalid user identity was accepted")
		}
	}
	request := httptest.NewRequest(http.MethodGet, "/api/projects", nil)
	request.Header.Set("X-Novai-User-ID", testUserID)
	request.Header.Set("X-Novai-Credential-Version", "v1")
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized || len(server.accounts) != 0 {
		t.Fatal("workspace opened without a trusted gateway")
	}
	for _, path := range []string{"/api/health/ready", "/health/ready"} {
		for _, method := range []string{http.MethodGet, http.MethodHead} {
			health := httptest.NewRecorder()
			server.ServeHTTP(health, httptest.NewRequest(method, path, nil))
			if health.Code != http.StatusOK || len(server.accounts) != 0 {
				t.Fatalf("internal health check %s %s failed or opened a workspace", method, path)
			}
			if method == http.MethodHead && health.Body.Len() != 0 {
				t.Fatal("HEAD health check returned a response body")
			}
		}
	}
}

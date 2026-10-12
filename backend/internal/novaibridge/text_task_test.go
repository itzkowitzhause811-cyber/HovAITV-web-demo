package novaibridge

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/model"
)

func createPlatformTextTask(t *testing.T, server *Server, selectedModel string) model.Task {
	t.Helper()
	prompt := "一加一等于几？只用中文回答。"
	input := map[string]any{
		"mode": "text", "prompt": prompt, "textOptions": map[string]any{"stream": true},
		"config": map[string]any{"model": selectedModel, "credentialRef": testCatalog(testUserID, "v1").CredentialRef},
	}
	var task model.Task
	decodeData(t, platformRequest(t, server, testUserID, http.MethodPost, "/api/tasks", map[string]any{"type": "canvas_text", "prompt": prompt, "model": selectedModel, "input": input}), &task)
	return task
}

func waitPlatformTextTask(t *testing.T, server *Server, taskID string) model.Task {
	t.Helper()
	var task model.Task
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		decodeData(t, platformRequest(t, server, testUserID, http.MethodGet, "/api/tasks/"+taskID, nil), &task)
		if task.Status == model.TaskStatusSucceeded || task.Status == model.TaskStatusFailed {
			return task
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("text task did not terminate: %+v", task)
	return task
}

func TestPlatformTextStreamsBeforeCompletionAndSurvivesRestart(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	release := make(chan struct{})
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	gateway := fakeGateway(t, func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if r.URL.Path != compatPath("text")+"/chat/completions" || r.Header.Get("Authorization") != "Bearer ephemeral-test-token" || json.NewDecoder(r.Body).Decode(&body) != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if body["stream"] != true || body["model"] != "text-test" {
			t.Errorf("original stream request changed: %#v", body)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"一加一\"}}]}\n\n")
		w.(http.Flusher).Flush()
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"等于二。\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
		w.(http.Flusher).Flush()
	})
	defer gateway.Close()
	root := t.TempDir()
	options := ServerOptions{DataDir: root, GatewayURL: gateway.URL, BridgeSecret: testBridgeSecret}
	server, err := NewServer(options)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = server.Close(context.Background()) }()
	defer unblock()
	task := createPlatformTextTask(t, server, "text-test")
	var replay app.TextReplayResult
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		decodeData(t, platformRequest(t, server, testUserID, http.MethodGet, "/api/tasks/"+task.ID+"/text-deltas", nil), &replay)
		if len(replay.Deltas) > 0 {
			break
		}
		time.Sleep(25 * time.Millisecond)
	}
	if len(replay.Deltas) != 1 || replay.Deltas[0].Content != "一加一" || replay.Complete || replay.FinalText != "" {
		t.Fatalf("stream was buffered until completion or not persisted: %+v", replay)
	}
	cursor := replay.Deltas[0].Sequence
	unblock()
	task = waitPlatformTextTask(t, server, task.ID)
	if task.Status != model.TaskStatusSucceeded || !strings.Contains(task.ResultJSON, "一加一等于二。") {
		t.Fatalf("stream result failed: %+v", task)
	}
	path := fmt.Sprintf("/api/tasks/%s/text-events?after=%d", task.ID, cursor)
	events := platformRequest(t, server, testUserID, http.MethodGet, path, nil)
	if events.Code != 200 || !strings.Contains(events.Body.String(), "event: terminal") || !strings.Contains(events.Body.String(), `"finalText":"一加一等于二。"`) || strings.Contains(events.Body.String(), fmt.Sprintf("id: %d\nevent: delta", cursor)) {
		t.Fatalf("cursor reconnect lost or duplicated text: %s", events.Body.String())
	}
	if response := platformRequest(t, server, secondTestUserID, http.MethodGet, path, nil); response.Code == 200 {
		t.Fatal("another account could replay the text")
	}
	if err := server.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	reopened, err := NewServer(options)
	if err != nil {
		t.Fatal(err)
	}
	server = reopened
	var restored model.Task
	decodeData(t, platformRequest(t, server, testUserID, http.MethodGet, "/api/tasks/"+task.ID, nil), &restored)
	if restored.Status != model.TaskStatusSucceeded || restored.ResultJSON != task.ResultJSON || restored.Attempts != task.Attempts {
		t.Fatalf("restart did not recover the original task: %+v", restored)
	}
	events = platformRequest(t, server, testUserID, http.MethodGet, path, nil)
	if !strings.Contains(events.Body.String(), `"finalText":"一加一等于二。"`) {
		t.Fatalf("restart lost final stream replay: %s", events.Body.String())
	}
}

func TestPlatformClosedEndpointFailureAllowsNewTaskWithAnotherModel(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	var calls atomic.Int32
	gateway := fakeGateway(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		var body map[string]any
		if json.NewDecoder(r.Body).Decode(&body) != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if body["model"] == "text-test" {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(400)
			_, _ = fmt.Fprint(w, `{"error":{"code":"InvalidEndpoint.ClosedEndpoint","message":"The selected model endpoint is closed"}}`)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"二。\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	})
	defer gateway.Close()
	server, err := NewServer(ServerOptions{DataDir: t.TempDir(), GatewayURL: gateway.URL, BridgeSecret: testBridgeSecret})
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close(context.Background())
	failed := createPlatformTextTask(t, server, "text-test")
	failed = waitPlatformTextTask(t, server, failed.ID)
	if failed.Status != model.TaskStatusFailed || failed.ErrorCode != "model_missing" || failed.Attempts != 1 || !strings.Contains(failed.Error, "当前模型的服务端点已关闭") || !strings.Contains(failed.Error, "请选择其他可用模型") {
		t.Fatalf("closed model failure was not persisted correctly: %+v", failed)
	}
	events := platformRequest(t, server, testUserID, http.MethodGet, "/api/tasks/"+failed.ID+"/text-events", nil)
	if !strings.Contains(events.Body.String(), "event: terminal") || !strings.Contains(events.Body.String(), "当前模型的服务端点已关闭") {
		t.Fatalf("failed stream cannot be recovered: %s", events.Body.String())
	}
	if response := platformRequest(t, server, testUserID, http.MethodPost, "/api/tasks/"+failed.ID+"/retry", nil); response.Code != 400 {
		t.Fatalf("closed endpoint was retried: %d %s", response.Code, response.Body.String())
	}
	if calls.Load() != 1 {
		t.Fatal("failed endpoint was called more than once")
	}
	replacement := createPlatformTextTask(t, server, "text-alternate")
	replacement = waitPlatformTextTask(t, server, replacement.ID)
	if replacement.ID == failed.ID || replacement.Status != model.TaskStatusSucceeded || !strings.Contains(replacement.ResultJSON, "二。") || calls.Load() != 2 {
		t.Fatalf("switching model did not create a successful new task: %+v", replacement)
	}
	var original model.Task
	decodeData(t, platformRequest(t, server, testUserID, http.MethodGet, "/api/tasks/"+failed.ID, nil), &original)
	if original.Status != failed.Status || original.Error != failed.Error || original.Attempts != failed.Attempts {
		t.Fatal("the new generation overwrote the failed task history")
	}
	for _, task := range []model.Task{original, replacement} {
		var input struct {
			Snapshot struct {
				Model    string `json:"model"`
				Protocol string `json:"protocol"`
			} `json:"platformModelSnapshot"`
		}
		if json.Unmarshal([]byte(task.InputJSON), &input) != nil || input.Snapshot.Model != task.Model || input.Snapshot.Protocol != "chat-completion" {
			t.Fatalf("terminal task lost admitted model history: %s", task.InputJSON)
		}
	}
}

package novaibridge

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"infinite-canvas/backend/internal/model"
)

// Exercise the resource-to-provider boundary used by main-library imports:
// the main asset ID stays stable while task inputs refer to durable bytes.
func TestPlatformMappedAssetSurvivesRestartAndFeedsTask(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	const imageBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6SAAAAABJRU5ErkJggg=="
	const mainAssetID = "33333333-3333-4333-8333-333333333333"
	const projectID = "44444444-4444-4444-8444-444444444444"
	image, _ := base64.StdEncoding.DecodeString(imageBase64)
	digest := sha256.Sum256(image)
	var validations atomic.Int32
	var rejectAt atomic.Int32
	captured := make(chan string, 1)
	gateway := fakeGateway(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/novtv/internal/asset-reference" {
			var input map[string]string
			_ = json.NewDecoder(r.Body).Decode(&input)
			count := validations.Add(1)
			valid := input["project_id"] == projectID && input["asset_id"] == mainAssetID && input["sha256"] == hex.EncodeToString(digest[:]) && (rejectAt.Load() == 0 || count < rejectAt.Load())
			_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": map[string]bool{"valid": valid}})
			return
		}
		body, _ := io.ReadAll(r.Body)
		captured <- string(body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":"reference received"},"finish_reason":"stop"}]}`)
	})
	defer gateway.Close()
	options := ServerOptions{DataDir: t.TempDir(), GatewayURL: gateway.URL, BridgeSecret: testBridgeSecret}
	server, err := NewServer(options)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = server.Close(context.Background()) }()
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	file, err := form.CreateFormFile("file", "reference.png")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = file.Write(image)
	_ = form.WriteField("kind", "image")
	_ = form.Close()
	request := httptest.NewRequest(http.MethodPost, "/api/resources", &body)
	request.Header.Set("Content-Type", form.FormDataContentType())
	request.Header.Set("X-Novai-Bridge-Secret", testBridgeSecret)
	request.Header.Set("X-Novai-User-ID", testUserID)
	request.Header.Set("X-Novai-Credential-Version", "v1")
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	var uploaded struct {
		Resource model.Resource `json:"resource"`
	}
	decodeData(t, response, &uploaded)
	resourceURL := "/api/resources/" + uploaded.Resource.ID + "/file"
	asset := map[string]any{"id": mainAssetID, "kind": "image", "title": "main project reference", "status": "confirmed", "coverUrl": resourceURL, "tags": []string{}, "source": "novai-project", "createdAt": time.Now().UTC().Format(time.RFC3339Nano), "updatedAt": time.Now().UTC().Format(time.RFC3339Nano), "metadata": map[string]any{"novaiAssetId": mainAssetID, "novaiProjectId": projectID}, "data": map[string]any{"storageKey": "resource:" + uploaded.Resource.ID, "dataUrl": resourceURL, "bytes": len(image), "mimeType": "image/png", "width": 1, "height": 1}}
	if saved := platformRequest(t, server, testUserID, http.MethodPut, "/api/assets/"+mainAssetID, map[string]any{"asset": asset}); saved.Code != http.StatusOK {
		t.Fatal(saved.Body.String())
	}
	canvasDoc := map[string]any{"id": projectID, "title": "Reference canvas", "revision": 0, "nodes": []any{map[string]any{"id": "reference-node", "type": "image", "metadata": map[string]any{"assetId": mainAssetID, "storageKey": "resource:" + uploaded.Resource.ID}}}, "connections": []any{}}
	if saved := platformRequest(t, server, testUserID, http.MethodPut, "/api/canvas-projects/"+projectID, map[string]any{"project": canvasDoc}); saved.Code != http.StatusOK {
		t.Fatal(saved.Body.String())
	}
	if err := server.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	server, err = NewServer(options)
	if err != nil {
		t.Fatal(err)
	}
	var restored struct {
		Asset map[string]any `json:"asset"`
	}
	decodeData(t, platformRequest(t, server, testUserID, http.MethodGet, "/api/assets/"+mainAssetID, nil), &restored)
	if restored.Asset["id"] != mainAssetID {
		t.Fatal("main asset mapping lost after restart")
	}
	for _, path := range []string{"/api/assets/" + mainAssetID, "/api/resources/" + uploaded.Resource.ID + "/file"} {
		if foreign := platformRequest(t, server, secondTestUserID, http.MethodGet, path, nil); foreign.Code == http.StatusOK {
			t.Fatal("foreign account read mapped media")
		}
	}
	input := map[string]any{"mode": "text", "prompt": "Describe the reference", "config": map[string]any{"model": "text-test", "credentialRef": testCatalog(testUserID, "v1").CredentialRef}, "referenceImages": []any{map[string]any{"id": mainAssetID, "assetId": "forged-asset", "url": "https://untrusted.example/image.png", "storageKey": "resource:" + uploaded.Resource.ID}}}
	var task model.Task
	taskBody := map[string]any{"type": "canvas_text", "prompt": "Describe the reference", "model": "text-test", "projectId": projectID, "input": input}
	decodeData(t, platformRequest(t, server, testUserID, http.MethodPost, "/api/tasks", taskBody), &task)
	task = waitPlatformTextTask(t, server, task.ID)
	if task.Status != model.TaskStatusSucceeded {
		t.Fatalf("reference task failed: %s", task.Error)
	}
	select {
	case payload := <-captured:
		var requestBody any
		if json.Unmarshal([]byte(payload), &requestBody) != nil || !strings.Contains(payload, imageBase64) || strings.Contains(payload, "untrusted.example") {
			t.Fatal("provider did not receive the stored image bytes")
		}
	default:
		t.Fatal("provider request missing")
	}
	if validations.Load() != 3 {
		t.Fatalf("registration/admission/execution validations = %d", validations.Load())
	}
	db, err := gorm.Open(sqlite.Open(filepath.Join(options.DataDir, testUserID, "open_ai_canvas.db")), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := db.DB()
	defer sqlDB.Close()
	var stored model.Task
	if err := db.First(&stored, "id = ?", task.ID).Error; err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stored.InputJSON, `"assetId":"`+mainAssetID+`"`) {
		t.Fatalf("main asset identity was not frozen in the stored task: %s", stored.InputJSON)
	}
	// Permit admission but revoke before execution; no second provider request.
	rejectAt.Store(validations.Load() + 2)
	decodeData(t, platformRequest(t, server, testUserID, http.MethodPost, "/api/tasks", taskBody), &task)
	task = waitPlatformTextTask(t, server, task.ID)
	if task.Status != model.TaskStatusFailed {
		t.Fatalf("revoked reference task status = %s", task.Status)
	}
	if task.ErrorCode != "input_inaccessible" || !strings.Contains(task.Error, "参考素材") {
		t.Fatalf("reference failure lost actionable classification: %s %s", task.ErrorCode, task.Error)
	}
	select {
	case <-captured:
		t.Fatal("provider called after revocation")
	default:
	}
}

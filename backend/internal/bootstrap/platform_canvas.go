package bootstrap

import (
	"encoding/json"
	"errors"
	"time"

	"gorm.io/gorm"
)

// The platform has already authorized this project. Its stable ID joins the
// existing NovAI project to an original HovAI canvas without translating nodes.
func (r *Runtime) EnsurePlatformCanvas(id, title string) error {
	owner, err := r.service.LocalWorkspaceOwner()
	if err != nil {
		return err
	}
	_, err = r.service.UserCanvasProject(owner.ID, id)
	if err == nil {
		return nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return err
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	document, err := json.Marshal(map[string]any{
		"id": id, "revision": 0, "workspaceProjectId": id, "title": title,
		"createdAt": now, "updatedAt": now, "nodes": []any{}, "connections": []any{},
		"chatSessions": []any{}, "activeChatId": nil, "backgroundMode": "dots",
		"showImageInfo": false, "viewport": map[string]any{"x": 0, "y": 0, "k": 1}, "directorScenes": []any{},
	})
	if err != nil {
		return err
	}
	_, err = r.service.UpsertUserCanvasProject(owner.ID, document)
	return err
}

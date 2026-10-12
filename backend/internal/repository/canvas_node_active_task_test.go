package repository

import (
	"testing"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"

	"infinite-canvas/backend/internal/model"
)

func TestActiveTaskCountForCanvasNode(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.Task{}); err != nil {
		t.Fatal(err)
	}
	repo := New(db)
	nodeTask := func(id, userID, nodeID string, status model.TaskStatus, withNode bool) {
		inputJSON := `{"mode":"image","config":{}}`
		if withNode {
			inputJSON = `{"mode":"image","metadata":{"nodeId":"` + nodeID + `"},"config":{}}`
		}
		if err := db.Create(&model.Task{ID: id, UserID: userID, Status: status, InputJSON: inputJSON}).Error; err != nil {
			t.Fatal(err)
		}
	}

	nodeTask("running", "user-1", "node-1", model.TaskStatusRunning, true)
	nodeTask("succeeded-old", "user-1", "node-1", model.TaskStatusSucceeded, true)
	nodeTask("queued-other-node", "user-1", "node-2", model.TaskStatusQueued, true)
	nodeTask("queued-other-user", "user-2", "node-1", model.TaskStatusQueued, true)
	nodeTask("running-no-node", "user-1", "", model.TaskStatusRunning, false)
	nodeTask("replay", "user-1", "node-3", model.TaskStatusTextReplay, true)

	if count, err := repo.ActiveTaskCountForCanvasNode("user-1", "node-1"); err != nil || count != 1 {
		t.Fatalf("active count for node-1 = %d, %v; want 1", count, err)
	}
	if count, err := repo.ActiveTaskCountForCanvasNode("user-1", "node-3"); err != nil || count != 1 {
		t.Fatalf("text_replay count for node-3 = %d, %v; want 1", count, err)
	}
	if count, err := repo.ActiveTaskCountForCanvasNode("user-2", "node-1"); err != nil || count != 1 {
		t.Fatalf("other user count = %d, %v; want 1", count, err)
	}
	if count, err := repo.ActiveTaskCountForCanvasNode("user-1", ""); err != nil || count != 0 {
		t.Fatalf("empty node id count = %d, %v; want 0", count, err)
	}

	if err := db.Model(&model.Task{}).Where("id = ?", "running").Update("status", model.TaskStatusSucceeded).Error; err != nil {
		t.Fatal(err)
	}
	if count, err := repo.ActiveTaskCountForCanvasNode("user-1", "node-1"); err != nil || count != 0 {
		t.Fatalf("terminal count for node-1 = %d, %v; want 0 (retry allowed)", count, err)
	}
}

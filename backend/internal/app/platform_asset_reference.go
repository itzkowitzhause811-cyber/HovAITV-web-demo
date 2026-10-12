package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"strings"

	"infinite-canvas/backend/internal/canvas"
)

// Optional platform boundary; standalone workspaces retain their resource policy.
type ExternalAssetAuthority interface {
	ValidateAssetReference(context.Context, string, string, string) error
}

func (s *Service) validatePlatformResource(ctx context.Context, userID, projectID, assetID, storageKey string) error {
	authority, ok := s.externalModels.(ExternalAssetAuthority)
	if !ok {
		return nil
	}
	if projectID == "" || assetID == "" || !strings.HasPrefix(storageKey, "resource:") {
		return BadAuthRequest("参考素材尚未绑定当前项目资产，请重新引入")
	}
	_, body, err := s.OpenResource(userID, strings.TrimPrefix(storageKey, "resource:"))
	if err != nil {
		return BadAuthRequest("参考素材不可读取，请重新引入")
	}
	defer body.Close()
	digest := sha256.New()
	const maxBytes = 500 << 20
	n, err := io.Copy(digest, io.LimitReader(body, maxBytes+1))
	if err != nil || n > maxBytes {
		return BadAuthRequest("参考素材读取失败或超出限制")
	}
	if err := authority.ValidateAssetReference(ctx, projectID, assetID, hex.EncodeToString(digest.Sum(nil))); err != nil {
		return BadAuthRequest("参考素材无法读取：项目素材已失效、内容不一致或无权访问，请重新选择素材")
	}
	return nil
}

func (s *Service) validatePlatformAssetRegistration(userID string, raw json.RawMessage) error {
	if _, ok := s.externalModels.(ExternalAssetAuthority); !ok {
		return nil
	}
	var asset struct {
		ID       string `json:"id"`
		Metadata struct {
			AssetID   string `json:"novaiAssetId"`
			ProjectID string `json:"novaiProjectId"`
		} `json:"metadata"`
		Data struct {
			StorageKey string `json:"storageKey"`
		} `json:"data"`
	}
	if json.Unmarshal(raw, &asset) != nil {
		return BadAuthRequest("素材数据格式错误")
	}
	if asset.Metadata.AssetID == "" && asset.Metadata.ProjectID == "" {
		return nil
	}
	if asset.ID != asset.Metadata.AssetID {
		return BadAuthRequest("主项目素材标识不一致")
	}
	return s.validatePlatformResource(context.Background(), userID, asset.Metadata.ProjectID, asset.ID, asset.Data.StorageKey)
}

// Admission resolves references from the saved canvas and overwrites client
// asset IDs. Execution uses those frozen IDs, independently of later node edits.
func (s *Service) validatePlatformTaskReferences(ctx context.Context, userID, projectID string, input *canvasGenerationInput, admission bool) error {
	if _, ok := s.externalModels.(ExternalAssetAuthority); !ok {
		return nil
	}
	groups := [][]providerMedia{input.ReferenceImages, input.ReferenceVideos, input.ReferenceAudios}
	count := len(input.ReferenceImages) + len(input.ReferenceVideos) + len(input.ReferenceAudios)
	if count == 0 {
		return nil
	}
	if count > 32 {
		return BadAuthRequest("参考素材数量超出限制")
	}
	bindings := map[string]string{}
	if admission {
		project, err := s.repo.CanvasProjectForUser(userID, projectID)
		if err != nil {
			return BadAuthRequest("请先保存当前画布，再生成")
		}
		references, err := canvas.MediaAssetReferences(json.RawMessage(project.PayloadJSON))
		if err != nil {
			return BadAuthRequest("画布参考素材格式错误")
		}
		for _, ref := range references {
			bindings["resource:"+ref.ResourceID] = ref.AssetID
		}
	}
	validated := map[string]bool{}
	for _, group := range groups {
		for i := range group {
			media := &group[i]
			if admission {
				media.AssetID = bindings[media.StorageKey]
			}
			key := media.AssetID + ":" + media.StorageKey
			if !validated[key] {
				if err := s.validatePlatformResource(ctx, userID, projectID, media.AssetID, media.StorageKey); err != nil {
					return err
				}
				validated[key] = true
			}
			// Provider hydration must consume the validated bytes, not a
			// caller-supplied URL or inline payload attached to the same ID.
			media.URL, media.DataURL = "", ""
		}
	}
	return nil
}

func (s *Service) admitPlatformTaskReferences(userID, projectID string, input map[string]any) error {
	if _, ok := s.externalModels.(ExternalAssetAuthority); !ok {
		return nil
	}
	delete(input, "platformAssetReferences")
	encoded, err := json.Marshal(input)
	if err != nil {
		return err
	}
	var typed canvasGenerationInput
	if err := json.Unmarshal(encoded, &typed); err != nil {
		return err
	}
	if err := s.validatePlatformTaskReferences(context.Background(), userID, projectID, &typed, true); err != nil {
		return err
	}
	references := []map[string]string{}
	for key, media := range map[string][]providerMedia{"referenceImages": typed.ReferenceImages, "referenceVideos": typed.ReferenceVideos, "referenceAudios": typed.ReferenceAudios} {
		if len(media) == 0 {
			continue
		}
		data, err := json.Marshal(media)
		if err != nil {
			return err
		}
		var normalized any
		if err := json.Unmarshal(data, &normalized); err != nil {
			return err
		}
		input[key] = normalized
		for _, item := range media {
			references = append(references, map[string]string{"projectId": projectID, "assetId": item.AssetID, "storageKey": item.StorageKey})
		}
	}
	if len(references) > 0 {
		input["platformAssetReferences"] = references
	}
	return nil
}

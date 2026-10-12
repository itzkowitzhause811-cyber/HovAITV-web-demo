package app

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"

	"infinite-canvas/backend/internal/model"
)

const maxExternalMediaBytes = 64 << 20

func (s *Service) stageExternalReferenceMedia(ctx context.Context, userID, resourceID string, resource *model.Resource, media *providerMedia, uploader ExternalMediaUploader) error {
	if resource == nil || (resource.Kind != "image" && resource.Kind != "audio" && resource.Kind != "video") || resource.Size <= 0 || resource.Size > maxExternalMediaBytes {
		return errors.New("平台模型参考媒体必须小于 64MB")
	}
	mimeType := strings.ToLower(strings.TrimSpace(resource.MimeType))
	policy, err := s.RuntimePolicy()
	if err != nil {
		return err
	}
	if resource.Size > int64(policy.Resource.ResourceUploadMB)<<20 {
		return errors.New("参考图片超过当前工作区资源大小限制")
	}
	_, body, err := s.OpenResource(userID, resourceID)
	if err != nil {
		return fmt.Errorf("读取任务参考资源失败：%w", err)
	}
	defer body.Close()
	if ctx == nil {
		ctx = context.Background()
	}
	staged, err := uploader.UploadMedia(ctx, ExternalMediaUpload{
		ResourceID: resourceID, Kind: resource.Kind, MimeType: mimeType, Size: resource.Size, Body: body,
	})
	if err != nil {
		return errors.New("平台参考图片暂时无法上传，请稍后重试")
	}
	parsed, err := url.Parse(staged)
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" || parsed.User != nil || parsed.Fragment != "" {
		return errors.New("平台参考图片返回了无效的访问地址")
	}
	media.URL = staged
	media.DataURL = ""
	media.MimeType = mimeType
	media.Bytes = resource.Size
	media.Width = resource.Width
	media.Height = resource.Height
	media.DurationMs = resource.DurationMs
	return nil
}

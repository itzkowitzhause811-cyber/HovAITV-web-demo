package novaibridge

import "context"

func (c *Client) ValidateAssetReference(ctx context.Context, projectID, assetID, digest string) error {
	var result struct {
		Valid bool `json:"valid"`
	}
	err := c.request(ctx, "POST", "/api/v1/novtv/internal/asset-reference", map[string]string{"project_id": projectID, "asset_id": assetID, "sha256": digest}, &result)
	if err != nil {
		return err
	}
	if !result.Valid {
		return errAuthorization
	}
	return nil
}

package installer

import (
	"errors"
	"fmt"

	"github.com/ebarti/jobctrl/launcher/internal/release"
)

// validatePlannedBridgePolicy must be re-run under both lifecycle locks before
// every handoff mutation, including recovery. Both metadata inputs come from
// authenticated descriptors; the source is bound separately by the signed
// bridge role and the current active-selection verifier.
func validatePlannedBridgePolicy(store *release.Store, source release.Receipt, bridge release.ChannelMetadata, target Descriptor, targetDigest string) error {
	if !source.Valid() || source.Channel == "local" || source.Channel != bridge.Channel || target.Channel != bridge.Channel || source.Sequence >= bridge.Sequence || bridge.Sequence >= target.Sequence || target.BuildID == source.BuildID || target.BuildID == bridge.BuildID || !sha256Pattern.MatchString(targetDigest) {
		return errors.New("source, bridge and final target do not form an ordered channel plan")
	}
	if target.MinimumSafeSequence < bridge.Minimum || target.MinimumSafeSequence > bridge.Sequence {
		return errors.New("final target policy does not retain the bridge at the required safety floor")
	}
	for _, id := range target.RevokedBuildIDs {
		if id == bridge.BuildID {
			return errors.New("final target revokes the bridge")
		}
	}
	for _, id := range bridge.Revoked {
		if id == target.BuildID {
			return errors.New("bridge policy revokes the final target")
		}
	}
	if _, err := store.ValidateMetadata(bridge); err != nil {
		return fmt.Errorf("bridge policy is not admissible: %w", err)
	}
	final := release.ChannelMetadata{Channel: target.Channel, Sequence: target.Sequence, Minimum: target.MinimumSafeSequence, BuildID: target.BuildID, DescriptorDigest: targetDigest, Revoked: target.RevokedBuildIDs}
	if _, err := store.ValidateMetadata(final); err != nil {
		return fmt.Errorf("final target policy is not admissible: %w", err)
	}
	return nil
}

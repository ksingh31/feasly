/**
 * Shared amenity category constants (#777). Imported by both the providers
 * (refresh side) and the read service, which must never import the
 * providers module itself.
 */

/**
 * Reserved `amenities.category` for the per-community public-tree cover row:
 * one row per established community, located at the community centre (City
 * "Community Points"). It doubles as the community anchor for community
 * metrics and is never counted as a nearby amenity.
 */
export const TREE_COVER_CATEGORY = 'tree-cover';

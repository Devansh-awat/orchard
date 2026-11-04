package release

// PublicKeys are the keys that may sign host commands, as base64 SPKI DER. Keep
// more than one while rotating. apps/server/hostbin/orchard-sync-commands holds
// the same list, and sync_test pins the two together.
//
// While this is empty, signatures aren't checked.
var PublicKeys = []string{
	"MCowBQYDK2VwAyEAGZ/AMiI95EFw93YNrsui6YQg3FMqdUVZ1FQh/+k92co=",
}

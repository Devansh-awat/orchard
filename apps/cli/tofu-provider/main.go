// terraform-provider-orchard serves Terraform and OpenTofu alike: both speak
// the same plugin protocol, and terraform-plugin-framework targets it.
package main

import (
	"context"
	"flag"
	"log"

	"github.com/hashicorp/terraform-plugin-framework/providerserver"

	"github.com/hackclub/orchard/cli/tofu-provider/internal/provider"
)

var version = "dev"

func main() {
	var debug bool
	flag.BoolVar(&debug, "debug", false, "run with support for debuggers like delve")
	flag.Parse()

	err := providerserver.Serve(context.Background(), provider.New(version), providerserver.ServeOpts{
		Address: "registry.terraform.io/hackclub/orchard",
		Debug:   debug,
	})
	if err != nil {
		log.Fatal(err)
	}
}

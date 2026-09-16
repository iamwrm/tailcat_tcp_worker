package main

import (
	"fmt"
	"slices"
	"strings"
	"tailscale.com/feature/featuretags"
)

func main() {
	keep := map[featuretags.FeatureTag]bool{}
	for dep := range featuretags.Requires("netstack") {
		keep[dep] = true
	}
	var tags []string
	for ft := range featuretags.Features {
		if ft != "" && ft.IsOmittable() && !keep[ft] {
			tags = append(tags, ft.OmitTag())
		}
	}
	slices.Sort(tags)
	fmt.Println(strings.Join(tags, ","))
}

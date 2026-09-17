//go:build linux

// A validation helper, never used by the client. Exits successfully only when
// the Linux container denies AF_NETLINK sockets with EPERM.
package main

import (
	"errors"
	"fmt"
	"os"
	"syscall"
)

func main() {
	fd, err := syscall.Socket(syscall.AF_NETLINK, syscall.SOCK_RAW, syscall.NETLINK_ROUTE)
	if fd >= 0 {
		syscall.Close(fd)
	}
	if !errors.Is(err, syscall.EPERM) {
		fmt.Fprintln(os.Stderr, "Expected netlink EPERM; restriction is not active")
		os.Exit(1)
	}
	fmt.Println("Confirmed: AF_NETLINK socket denied with EPERM")
}

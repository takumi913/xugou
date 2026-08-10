//go:build !windows

package selfmgmt

import "os"

func IsRoot() bool { return os.Geteuid() == 0 }

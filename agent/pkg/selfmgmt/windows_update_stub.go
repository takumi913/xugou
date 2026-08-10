//go:build !windows

package selfmgmt

import "errors"

var ErrUpdateScheduled = errors.New("update replacement helper scheduled")

func LaunchWindowsUpdateHelper(_, _, _ string) error {
	return errors.New("windows update helper is only available on windows")
}

func RunWindowsUpdateHelper(_ int, _, _, _ string) error {
	return errors.New("windows update helper is only available on windows")
}

//go:build windows

package selfmgmt

import (
	"errors"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func TestRunWindowsUpdateHelperRestartsService(t *testing.T) {
	var waited, replaced, serviceRestarted, consoleRestarted, cleaned bool
	operations := windowsUpdateOperations{
		waitParent: func(pid int) error {
			waited = pid == 42
			return nil
		},
		replace: func(source, target, expected string) error {
			replaced = source == `C:\Program Files\Xugou\agent.update-payload.exe` &&
				target == `C:\Program Files\Xugou\agent.exe` && expected == "1.2.3"
			return nil
		},
		serviceMode: func(pid int) bool { return pid == 42 },
		restartService: func() error {
			serviceRestarted = true
			return nil
		},
		restartConsole: func(string) error {
			consoleRestarted = true
			return nil
		},
		scheduleCleanup: func() { cleaned = true },
	}
	if err := runWindowsUpdateHelper(
		42,
		`C:\Program Files\Xugou\agent.update-payload.exe`,
		`C:\Program Files\Xugou\agent.exe`,
		"1.2.3",
		operations,
	); err != nil {
		t.Fatal(err)
	}
	if !waited || !replaced || !serviceRestarted || consoleRestarted || !cleaned {
		t.Fatalf("unexpected service flow: waited=%v replaced=%v service=%v console=%v cleanup=%v",
			waited, replaced, serviceRestarted, consoleRestarted, cleaned)
	}
}

func TestRunWindowsUpdateHelperRestartsConsole(t *testing.T) {
	var consoleTarget string
	operations := windowsUpdateOperations{
		waitParent:     func(int) error { return nil },
		replace:        func(string, string, string) error { return nil },
		serviceMode:    func(int) bool { return false },
		restartService: func() error { return errors.New("unexpected service restart") },
		restartConsole: func(target string) error {
			consoleTarget = target
			return nil
		},
		scheduleCleanup: func() {},
	}
	if err := runWindowsUpdateHelper(
		7,
		`C:\Xugou Dir\payload.exe`,
		`C:\Xugou Dir\agent.exe`,
		"2.0.0-rc.2",
		operations,
	); err != nil {
		t.Fatal(err)
	}
	if consoleTarget != `C:\Xugou Dir\agent.exe` {
		t.Fatalf("unexpected console target: %q", consoleTarget)
	}
}

func TestRunWindowsUpdateHelperRestartsRestoredVersionOnReplacementFailure(t *testing.T) {
	restarted, cleaned := false, false
	operations := windowsUpdateOperations{
		waitParent: func(int) error { return nil },
		replace: func(string, string, string) error {
			return errors.New("health probe failed and rollback completed")
		},
		serviceMode: func(int) bool { return true },
		restartService: func() error {
			restarted = true
			return nil
		},
		restartConsole:  func(string) error { return nil },
		scheduleCleanup: func() { cleaned = true },
	}
	if err := runWindowsUpdateHelper(
		9,
		`C:\Xugou\payload.exe`,
		`C:\Xugou\agent.exe`,
		"3.0.0",
		operations,
	); err == nil {
		t.Fatal("replacement failure must propagate")
	}
	if !restarted {
		t.Fatal("restored version must restart after replacement rollback")
	}
	if !cleaned {
		t.Fatal("helper and payload cleanup must be scheduled after failure")
	}
}

func TestRetryWindowsReplacementHandlesFileLocksAndAntivirusDelay(t *testing.T) {
	attempts := 0
	var delays []time.Duration
	err := retryWindowsReplacement(
		func() error {
			attempts++
			if attempts < 3 {
				return windows.ERROR_SHARING_VIOLATION
			}
			return nil
		},
		func(delay time.Duration) { delays = append(delays, delay) },
		5,
	)
	if err != nil {
		t.Fatal(err)
	}
	if attempts != 3 {
		t.Fatalf("unexpected attempts: %d", attempts)
	}
	if len(delays) != 2 || delays[0] != 250*time.Millisecond || delays[1] != 500*time.Millisecond {
		t.Fatalf("unexpected retry delays: %v", delays)
	}
}

func TestRetryWindowsReplacementDoesNotRetryHealthFailure(t *testing.T) {
	attempts := 0
	wanted := errors.New("signed version health probe failed")
	err := retryWindowsReplacement(
		func() error {
			attempts++
			return wanted
		},
		func(time.Duration) {},
		18,
	)
	if !errors.Is(err, wanted) || attempts != 1 {
		t.Fatalf("unexpected permanent failure result: attempts=%d err=%v", attempts, err)
	}
}

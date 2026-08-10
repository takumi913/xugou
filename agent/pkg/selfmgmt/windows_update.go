//go:build windows

package selfmgmt

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
)

var ErrUpdateScheduled = errors.New("update replacement helper scheduled")

// LaunchWindowsUpdateHelper 复制独立 helper 后启动；调用方随后退出以释放旧 exe。
func LaunchWindowsUpdateHelper(source, target, expectedVersion string) error {
	helperPath := target + ".update-helper.exe"
	payloadPath := target + ".update-payload.exe"
	_ = os.Remove(helperPath)
	_ = os.Remove(payloadPath)
	copyFile := func(destination string) error {
		input, err := os.Open(source)
		if err != nil {
			return err
		}
		defer input.Close()
		output, err := os.OpenFile(destination, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
		if err != nil {
			return err
		}
		_, copyErr := io.Copy(output, input)
		if copyErr == nil {
			copyErr = output.Sync()
		}
		if closeErr := output.Close(); copyErr == nil {
			copyErr = closeErr
		}
		return copyErr
	}
	if err := copyFile(helperPath); err != nil {
		return fmt.Errorf("copy update helper: %w", err)
	}
	if err := copyFile(payloadPath); err != nil {
		_ = os.Remove(helperPath)
		return fmt.Errorf("copy update payload: %w", err)
	}
	command := exec.Command(helperPath, "update-helper",
		"--parent-pid", strconv.Itoa(os.Getpid()),
		"--source", payloadPath,
		"--target", target,
		"--expected", expectedVersion,
	)
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NEW_PROCESS_GROUP}
	if err := command.Start(); err != nil {
		_ = os.Remove(helperPath)
		_ = os.Remove(payloadPath)
		return fmt.Errorf("start update helper: %w", err)
	}
	return ErrUpdateScheduled
}

func waitForWindowsProcess(pid int) error {
	handle, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
		return nil
	}
	if err != nil {
		return err
	}
	defer windows.CloseHandle(handle)
	status, err := windows.WaitForSingleObject(handle, 60_000)
	if err != nil {
		return err
	}
	if status == uint32(windows.WAIT_TIMEOUT) {
		return errors.New("parent process exit timeout")
	}
	return nil
}

type windowsUpdateOperations struct {
	waitParent      func(int) error
	replace         func(string, string, string) error
	serviceMode     func(int) bool
	restartService  func() error
	restartConsole  func(string) error
	scheduleCleanup func()
}

var servicePIDPattern = regexp.MustCompile(`(?mi)^\s*PID\s*:\s*([0-9]+)\s*$`)

func windowsServiceOwnsProcess(pid int) bool {
	output, err := exec.Command("sc.exe", "queryex", ServiceName).Output()
	if err != nil {
		return false
	}
	match := servicePIDPattern.FindSubmatch(output)
	if len(match) != 2 {
		return false
	}
	servicePID, err := strconv.Atoi(string(match[1]))
	return err == nil && servicePID == pid
}

func isTransientWindowsReplacementError(err error) bool {
	return errors.Is(err, windows.ERROR_SHARING_VIOLATION) ||
		errors.Is(err, windows.ERROR_LOCK_VIOLATION) ||
		errors.Is(err, windows.ERROR_ACCESS_DENIED) ||
		errors.Is(err, windows.ERROR_FILE_EXISTS) ||
		errors.Is(err, windows.ERROR_ALREADY_EXISTS)
}

func retryWindowsReplacement(
	replace func() error,
	sleep func(time.Duration),
	maxAttempts int,
) error {
	delay := 250 * time.Millisecond
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		err := replace()
		if err == nil {
			return nil
		}
		if !isTransientWindowsReplacementError(err) || attempt == maxAttempts {
			return err
		}
		sleep(delay)
		delay = min(delay*2, 2*time.Second)
	}
	return errors.New("windows replacement retry exhausted")
}

func runWindowsUpdateHelper(
	parentPID int,
	source, target, expectedVersion string,
	operations windowsUpdateOperations,
) error {
	cleanSource := filepath.Clean(source)
	cleanTarget := filepath.Clean(target)
	if parentPID <= 0 || !filepath.IsAbs(cleanSource) || !filepath.IsAbs(cleanTarget) ||
		strings.EqualFold(cleanSource, cleanTarget) || strings.TrimSpace(expectedVersion) == "" {
		return errors.New("invalid update helper arguments")
	}
	defer operations.scheduleCleanup()
	serviceMode := operations.serviceMode(parentPID)
	if err := operations.waitParent(parentPID); err != nil {
		return fmt.Errorf("wait parent: %w", err)
	}
	restart := func() error {
		if serviceMode {
			if err := operations.restartService(); err != nil {
				return fmt.Errorf("restart windows service: %w", err)
			}
			return nil
		}
		if err := operations.restartConsole(cleanTarget); err != nil {
			return fmt.Errorf("restart console agent: %w", err)
		}
		return nil
	}
	if err := operations.replace(cleanSource, cleanTarget, expectedVersion); err != nil {
		if restartErr := restart(); restartErr != nil {
			return fmt.Errorf("%v; restored version restart failed: %w", err, restartErr)
		}
		return err
	}
	return restart()
}

// RunWindowsUpdateHelper 等待父进程退出，执行替换/探活/回滚，再恢复服务或控制台进程。
func RunWindowsUpdateHelper(parentPID int, source, target, expectedVersion string) error {
	return runWindowsUpdateHelper(parentPID, source, target, expectedVersion, windowsUpdateOperations{
		waitParent: waitForWindowsProcess,
		replace: func(source, target, expectedVersion string) error {
			return retryWindowsReplacement(
				func() error {
					return ReplaceExecutableWithHealthCheck(
						source,
						target,
						expectedVersion,
					)
				},
				time.Sleep,
				18,
			)
		},
		serviceMode: windowsServiceOwnsProcess,
		restartService: func() error {
			output, err := exec.Command("sc.exe", "start", ServiceName).CombinedOutput()
			if err != nil {
				return fmt.Errorf("%w: %s", err, output)
			}
			return nil
		},
		restartConsole: func(executable string) error {
			command := exec.Command(executable, "start")
			command.SysProcAttr = &syscall.SysProcAttr{
				HideWindow:    true,
				CreationFlags: windows.CREATE_NEW_PROCESS_GROUP,
			}
			return command.Start()
		},
		scheduleCleanup: func() {
			// helper 退出后由 cmd 延迟清理自身。
			helper, _ := os.Executable()
			cleanup := exec.Command(
				"cmd.exe", "/C",
				"ping 127.0.0.1 -n 3 >NUL & del /F /Q \""+helper+"\" & del /F /Q \""+source+"\"",
			)
			cleanup.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
			_ = cleanup.Start()
			time.Sleep(50 * time.Millisecond)
		},
	})
}

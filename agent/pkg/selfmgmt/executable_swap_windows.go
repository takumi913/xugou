//go:build windows

package selfmgmt

import (
	"fmt"
	"os"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

const replaceFileWriteThrough = 0x00000001

var replaceFileW = windows.NewLazySystemDLL("kernel32.dll").NewProc("ReplaceFileW")

func replaceWindowsFile(target, replacement, backup string) error {
	targetPointer, err := windows.UTF16PtrFromString(target)
	if err != nil {
		return err
	}
	replacementPointer, err := windows.UTF16PtrFromString(replacement)
	if err != nil {
		return err
	}
	var backupPointer *uint16
	if backup != "" {
		backupPointer, err = windows.UTF16PtrFromString(backup)
		if err != nil {
			return err
		}
	}
	result, _, callErr := replaceFileW.Call(
		uintptr(unsafe.Pointer(targetPointer)),
		uintptr(unsafe.Pointer(replacementPointer)),
		uintptr(unsafe.Pointer(backupPointer)),
		replaceFileWriteThrough,
		0,
		0,
	)
	if result == 0 {
		if callErr != nil && callErr != syscall.Errno(0) {
			return callErr
		}
		return syscall.EINVAL
	}
	return nil
}

func installExecutable(newPath, target, backup string) error {
	if err := os.Remove(backup); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("清理旧备份失败: %w", err)
	}
	return replaceWindowsFile(target, newPath, backup)
}

func restoreExecutable(target, backup string) error {
	return replaceWindowsFile(target, backup, "")
}

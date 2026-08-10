//go:build windows

package selfmgmt

// Windows 不支持对目录句柄执行 fsync。文件自身已在替换前 Flush，后续
// MoveFile 操作由同卷原子重命名保证，目录同步在此作为平台级空操作。
func syncDirectory(_ string) error {
	return nil
}

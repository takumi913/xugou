interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{
    outcome: "accepted" | "dismissed";
    platform: string;
  }>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null; // 用于存储 beforeinstallprompt 事件

/**
 * 监听 'beforeinstallprompt' 事件。
 * 当浏览器准备好提示用户安装 PWA 时，此事件会触发。
 */
window.addEventListener('beforeinstallprompt', (e) => {
  // 阻止浏览器默认的迷你信息栏提示 (在某些移动浏览器上)
  e.preventDefault();
  // 保存事件，以便稍后可以触发它
  deferredPrompt = e as BeforeInstallPromptEvent;
  // 派发一个自定义事件，通知应用 PWA 可以安装了
  // 这允许 UI 组件（如 Navbar）更新其状态
  window.dispatchEvent(new CustomEvent('pwaInstallReady', { detail: { canInstall: true } }));
});

/**
 * 检查 PWA 是否可以被安装。
 * @warning 此函数已被注释掉，因为 PWA 安装可用性变化的时候，React 组件不知道怎么更新。后续再计划实现
 * @returns {boolean} 如果可以安装则返回 true，否则返回 false。
 */
// export const canInstallPWA = (): boolean => {
//   return !!deferredPrompt;
// };

/**
 * 触发 PWA 安装提示。
 * @returns {Promise<boolean>} 如果用户接受了安装提示，则解析为 true，否则为 false。
 */
export const promptPWAInstall = async (): Promise<boolean> => {
  if (!deferredPrompt) {
    console.warn('PWA 安装提示不可用或已被使用。');
    return false;
  }
  // 显示安装提示
  deferredPrompt.prompt();
  // 等待用户对提示做出响应
  try {
    const { outcome } = await deferredPrompt.userChoice;
    // 清除 deferredPrompt，因为它只能使用一次
    deferredPrompt = null;
    // 派发自定义事件，通知 PWA 安装状态已更改
    window.dispatchEvent(new CustomEvent('pwaInstallReady', { detail: { canInstall: false } }));
    return outcome === 'accepted';
  } catch (error) {
    console.error('PWA 安装提示时发生错误:', error);
    deferredPrompt = null;
    window.dispatchEvent(new CustomEvent('pwaInstallReady', { detail: { canInstall: false } }));
    return false;
  }
};

/**
 * 监听 'appinstalled' 事件。
 * 当 PWA 成功安装后，此事件会触发。
 */
window.addEventListener('appinstalled', () => {
  // PWA 安装后，deferredPrompt 通常应为 null，
  // 因为 beforeinstallprompt 不会再次触发，直到应用被卸载（在某些情况下）
  deferredPrompt = null;
  window.dispatchEvent(new CustomEvent('pwaInstallReady', { detail: { canInstall: false } }));
});

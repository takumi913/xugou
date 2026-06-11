import { compare, hash } from "bcryptjs";
import * as repositories from "../repositories";
import * as NotificationService from "./NotificationService"; // 导入通知服务

export async function getAllUsersService(userRole: string) {
  try {
    // 检查权限
    if (userRole !== "admin") {
      return { success: false, message: "无权访问用户列表", status: 403 };
    }

    // 查询所有用户，不包括密码
    const result = await repositories.getAllUsers();

    return { success: true, users: result, status: 200 };
  } catch (error) {
    console.error("获取用户列表错误:", error);
    return { success: false, message: "获取用户列表失败", status: 500 };
  }
}

export async function getUserByIdService(
  id: number,
  currentUserId: number,
  userRole: string
) {
  try {
    // 检查权限（仅允许管理员或用户本人）
    if (userRole !== "admin" && currentUserId !== id) {
      return { success: false, message: "无权访问此用户信息", status: 403 };
    }

    // 查询用户，不包括密码
    const user = await repositories.getUserById(id);

    if (!user) {
      return { success: false, message: "用户不存在", status: 404 };
    }

    return { success: true, user, status: 200 };
  } catch (error) {
    console.error("获取用户详情错误:", error);
    return { success: false, message: "获取用户详情失败", status: 500 };
  }
}

export async function createUserService(
  userData: {
    username: string;
    password: string;
    email?: string | null;
    role: string;
  },
  userRole: string
) {
  try {
    // 检查权限
    if (userRole !== "admin") {
      return { success: false, message: "无权创建用户", status: 403 };
    }

    // 验证必填字段
    if (!userData.username || !userData.password || !userData.role) {
      return { success: false, message: "缺少必填字段", status: 400 };
    }

    // 检查用户名是否已存在
    const existingUser = await repositories.checkUserExists(userData.username);

    if (existingUser) {
      return { success: false, message: "用户名已存在", status: 400 };
    }

    // 检查角色是否有效，只能创建 manager 或 user
    const validRoles = ["manager", "user"];
    if (!validRoles.includes(userData.role)) {
      return {
        success: false,
        message: "只能创建 manager 或 user 角色",
        status: 400,
      };
    }

    // 哈希密码
    const hashedPassword = await hash(userData.password, 10);

    // 插入新用户
    const newUser = await repositories.createUser(
      userData.username,
      hashedPassword,
      userData.email || null,
      userData.role
    );

    // 为新用户创建默认的通知设置
    if (newUser && newUser.id) {
      await NotificationService.createDefaultNotificationSettingsForUser(newUser.id);
    }

    return { success: true, user: newUser, status: 201 };
  } catch (error) {
    console.error("创建用户错误:", error);
    return { success: false, message: "创建用户失败", status: 500 };
  }
}

export async function updateUserService(
  id: number,
  updateData: {
    username?: string;
    email?: string | null;
    role?: string;
    password?: string;
  },
  currentUserId: number,
  userRole: string
) {
  try {
    // 检查权限（仅允许管理员或用户本人）
    if (userRole !== "admin" && currentUserId !== id) {
      return { success: false, message: "无权修改此用户信息", status: 403 };
    }

    // 检查用户是否存在
    const user = await repositories.getFullUserById(id);
    if (!user) {
      return { success: false, message: "用户不存在", status: 404 };
    }

    // 非管理员不能修改角色
    if (
      userRole !== "admin" &&
      updateData.role &&
      updateData.role !== user.role
    ) {
      return { success: false, message: "无权修改用户角色", status: 403 };
    }

    // 关于角色的严格校验 - 只有在角色字段被实际修改时才触发
    if (updateData.role && updateData.role !== user.role) {
      // 1. 禁止将任何用户的角色设置为 'admin'
      if (updateData.role === "admin") {
        return {
          success: false,
          message: "不允许将用户角色设置为 Admin",
          status: 403,
        };
      }
      // 2. 禁止修改 'admin' 用户自身的角色
      if (user.role === "admin") {
        return {
          success: false,
          message: "Admin 用户的角色不能被修改",
          status: 403,
        };
      }
      // 3. 校验角色是否合法
      const validRoles = ["manager", "user"];
      if (!validRoles.includes(updateData.role)) {
        return { success: false, message: "无效的用户角色", status: 400 };
      }
    }

    // 准备更新数据
    const updates: {
      username?: string;
      email?: string | null;
      role?: string;
      password?: string;
    } = {};

    if (
      updateData.username !== undefined &&
      updateData.username !== user.username
    ) {
      const existingUser = await repositories.checkUserExists(
        updateData.username
      );
      if (existingUser) {
        return { success: false, message: "用户名已存在", status: 400 };
      }
      updates.username = updateData.username;
    }

    if (updateData.email !== undefined) {
      updates.email = updateData.email;
    }

    if (updateData.role !== undefined && updateData.role !== user.role) {
      updates.role = updateData.role;
    }

    if (updateData.password) {
      updates.password = await hash(updateData.password, 10);
    }

    // 如果没有要更新的字段，则提前返回
    if (Object.keys(updates).length === 0) {
      return {
        success: true,
        user: user,
        message: "没有需要更新的字段",
        status: 200,
      };
    }

    // 执行更新
    const updatedUser = await repositories.updateUser(id, updates);
    return { success: true, user: updatedUser, status: 200 };
  } catch (error) {
    console.error("更新用户错误:", error);
    return { success: false, message: "更新用户失败", status: 500 };
  }
}

export async function deleteUserService(
  id: number,
  currentUserId: number,
  userRole: string
) {
  try {
    // 检查权限
    if (userRole !== "admin") {
      return { success: false, message: "无权删除用户", status: 403 };
    }

    // 防止删除自己
    if (currentUserId === id) {
      return { success: false, message: "不能删除当前登录的用户", status: 400 };
    }

    // 检查用户是否存在
    const user = await repositories.getUserById(id);
    if (!user) {
      return { success: false, message: "用户不存在", status: 404 };
    }

    // admin 用户不能被删除
    if (user.role === "admin") {
      return {
        success: false,
        message: "admin 用户不允许被删除",
        status: 403,
      };
    }

    // 在删除用户之前，先删除所有关联数据
    // 删除关联的监控项目
    await repositories.deleteMonitorsByUserId(id);
    // 删除关联的客户端
    await repositories.deleteAgentsByUserId(id);
    // 删除关联的通知设置
    await repositories.deleteNotificationSettingsByUserId(id);
    // 删除关联的通知模板
    await repositories.deleteNotificationTemplatesByUserId(id);
    // 删除关联的通知渠道
    await repositories.deleteNotificationChannelsByUserId(id);
    // 删除关联的状态页配置
    await repositories.deleteStatusPageConfigByUserId(id);


    // 执行删除
    await repositories.deleteUser(id);

    return { success: true, message: "用户已删除", status: 200 };
  } catch (error) {
    console.error("删除用户错误:", error);
    return { success: false, message: "删除用户失败", status: 500 };
  }
}

export async function changePasswordService(
  id: number,
  passwordData: {
    currentPassword?: string;
    newPassword: string;
  }
) {
  try {
    if (!passwordData.newPassword) {
      return { success: false, message: "新密码不能为空", status: 400 };
    }

    // 获取用户
    const user = await repositories.getFullUserById(id);
    if (!user) {
      return { success: false, message: "用户不存在", status: 404 };
    }

    // 如果提供了 currentPassword，则必须验证
    if (passwordData.currentPassword) {
      const isPasswordValid = await compare(
        passwordData.currentPassword,
        user.password
      );
      if (!isPasswordValid) {
        return { success: false, message: "当前密码无效", status: 400 };
      }
    }

    // 哈希新密码
    const hashedPassword = await hash(passwordData.newPassword, 10);

    // 更新密码
    await repositories.updateUserPassword(id, hashedPassword);

    return { success: true, message: "密码已更新", status: 200 };
  } catch (error) {
    console.error("修改密码错误:", error);
    return { success: false, message: "修改密码失败", status: 500 };
  }
}

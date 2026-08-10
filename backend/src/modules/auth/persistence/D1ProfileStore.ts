import { compare, hash } from "bcryptjs";
import type { Bindings } from "../../../models/db";

const PRIMARY_ADMIN_ID = 1;

interface AdminRow {
  id: number;
  username: string;
  password: string;
  email: string | null;
  created_at: string;
  updated_at: string;
}

function publicAdmin(row: AdminRow) {
  const { password: _password, ...admin } = row;
  return admin;
}

export async function updateAdminProfile(
  env: Bindings,
  id: number,
  input: { username?: string; email?: string | null }
) {
  try {
    const user = await env.DB.prepare(
      `SELECT * FROM users WHERE id = ? AND id = ? LIMIT 1`
    )
      .bind(PRIMARY_ADMIN_ID, id)
      .first<AdminRow>();
    if (!user) {
      return { success: false, message: "管理员账号不存在", status: 404 as const };
    }
    if (input.username && input.username !== user.username) {
      const duplicate = await env.DB.prepare(
        `SELECT id FROM users WHERE id = ? AND username = ? LIMIT 1`
      )
        .bind(PRIMARY_ADMIN_ID, input.username)
        .first<{ id: number }>();
      if (duplicate) {
        return { success: false, message: "用户名已存在", status: 400 as const };
      }
    }
    const username = input.username ?? user.username;
    const email = input.email === undefined ? user.email : input.email;
    const updatedAt = new Date().toISOString();
    const updated = await env.DB.prepare(
      `UPDATE users SET username = ?, email = ?, updated_at = ?
       WHERE id = ? AND id = ? RETURNING *`
    )
      .bind(username, email, updatedAt, PRIMARY_ADMIN_ID, id)
      .first<AdminRow>();
    if (!updated) throw new Error("更新管理员资料失败");
    return { success: true, user: publicAdmin(updated), status: 200 as const };
  } catch (error) {
    return { success: false, message: "更新资料失败", status: 500 as const };
  }
}

export async function changeAdminPassword(
  env: Bindings,
  id: number,
  input: { currentPassword: string; newPassword: string }
) {
  try {
    const user = await env.DB.prepare(
      `SELECT * FROM users WHERE id = ? AND id = ? LIMIT 1`
    )
      .bind(PRIMARY_ADMIN_ID, id)
      .first<AdminRow>();
    if (!user) {
      return { success: false, message: "管理员账号不存在", status: 404 as const };
    }
    if (!(await compare(input.currentPassword, user.password))) {
      return { success: false, message: "当前密码无效", status: 400 as const };
    }
    const updatedAt = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE users SET password = ?, updated_at = ? WHERE id = ? AND id = ?`
    )
      .bind(await hash(input.newPassword, 12), updatedAt, PRIMARY_ADMIN_ID, id)
      .run();
    return { success: true, message: "密码已更新", status: 200 as const };
  } catch (error) {
    return { success: false, message: "修改密码失败", status: 500 as const };
  }
}

import { Hono } from "hono";
import { JwtPayload } from "../types";
import { Bindings } from "../models/db";
import {
  getAllUsersService,
  getUserByIdService,
  createUserService,
  updateUserService,
  deleteUserService,
  changePasswordService,
} from "../services/UserService";
import {
  badRequest,
  changePasswordSchema,
  idParamSchema,
  userCreateSchema,
  userUpdateSchema,
} from "./schemas";

const users = new Hono<{ Bindings: Bindings; Variables: { jwtPayload: JwtPayload } }>();

// 获取所有用户（仅管理员）
users.get("/", async (c) => {
  try {
    const payload = c.get("jwtPayload") as JwtPayload;

    const result = await getAllUsersService(payload.role);

    return c.json(
      { success: result.success, users: result.users, message: result.message },
      result.status as any
    );
  } catch (error) {
    console.error("获取用户列表错误:", error);
    return c.json({ success: false, message: "获取用户列表失败" }, 500);
  }
});

// 获取单个用户
users.get("/:id", async (c) => {
  try {
    const id = idParamSchema.parse(c.req.param("id"));
    const payload = c.get("jwtPayload") as JwtPayload;

    const result = await getUserByIdService(id, payload.id, payload.role);

    return c.json(
      { success: result.success, user: result.user, message: result.message },
      result.status as any
    );
  } catch (error) {
    console.error("获取用户详情错误:", error);
    return c.json({ success: false, message: "获取用户详情失败" }, 500);
  }
});

// 创建用户（仅管理员）
users.post("/", async (c) => {
  try {
    const payload = c.get("jwtPayload") as JwtPayload;
    const parsed = userCreateSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(badRequest("用户创建参数无效"), 400);
    }

    const result = await createUserService(parsed.data, payload.role);

    return c.json(
      { success: result.success, user: result.user, message: result.message },
      result.status as any
    );
  } catch (error) {
    console.error("创建用户错误:", error);
    return c.json({ success: false, message: "创建用户失败" }, 500);
  }
});

// 更新用户
users.put("/:id", async (c) => {
  try {
    const id = idParamSchema.parse(c.req.param("id"));
    const payload = c.get("jwtPayload") as JwtPayload;
    const parsed = userUpdateSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(badRequest("用户更新参数无效"), 400);
    }

    const result = await updateUserService(
      id,
      parsed.data,
      payload.id,
      payload.role
    );

    return c.json(
      { success: result.success, user: result.user, message: result.message },
      result.status as any
    );
  } catch (error) {
    console.error("更新用户错误:", error);
    return c.json({ success: false, message: "更新用户失败" }, 500);
  }
});

// 删除用户（仅管理员）
users.delete("/:id", async (c) => {
  try {
    const id = idParamSchema.parse(c.req.param("id"));
    const payload = c.get("jwtPayload") as JwtPayload;

    const result = await deleteUserService(id, payload.id, payload.role);

    return c.json(
      { success: result.success, message: result.message },
      result.status as any
    );
  } catch (error) {
    console.error("删除用户错误:", error);
    return c.json({ success: false, message: "删除用户失败" }, 500);
  }
});

// 修改密码
users.post("/:id/change-password", async (c) => {
  try {
    const id = idParamSchema.parse(c.req.param("id"));
    const parsed = changePasswordSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(badRequest("密码参数无效"), 400);
    }

    const result = await changePasswordService(
      id,
      parsed.data,
    );

    return c.json(
      { success: result.success, message: result.message },
      result.status as any
    );
  } catch (error) {
    console.error("修改密码错误:", error);
    return c.json({ success: false, message: "修改密码失败" }, 500);
  }
});

export { users };

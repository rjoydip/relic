// @ts-nocheck
import { Controller, Get, Param, Post, Body } from "@nestjs/common";

@Controller("users")
export class UsersController {
  @Get()
  findAll() {
    return [];
  }

  @Get(":id")
  findOne(@Param("id") id: string) {
    return { id };
  }

  @Post()
  create(@Body() body: unknown) {
    return body;
  }
}

package com.example;

import com.example.UserService;

public class UserServiceTest {
    public void testUpdate() {
        UserService service = new UserService();
        service.update("u1");
    }
}

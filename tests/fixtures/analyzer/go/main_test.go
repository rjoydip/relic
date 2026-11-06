package main

import "testing"

func TestGetUser(t *testing.T) {
    if GetUser("u1") != "u1" {
        t.Fatal("unexpected")
    }
}

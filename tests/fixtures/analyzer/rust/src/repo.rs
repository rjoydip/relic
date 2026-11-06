pub struct Repo {
    table: String,
}

impl Repo {
    pub fn update(&self, id: &str) -> String {
        self.query("UPDATE users SET name = ?")
    }

    pub fn query(&self) -> String {
        String::from("SELECT * FROM users")
    }
}

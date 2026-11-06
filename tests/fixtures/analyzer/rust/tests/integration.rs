mod repo;

#[test]
fn updates_user() {
    let repo = repo::Repo {};
    repo.update("u1");
}

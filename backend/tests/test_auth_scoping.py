import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.database import SessionLocal
from app.models import User, Client

client = TestClient(app)

def test_health_check():
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "healthy"

def test_login_and_scoping():
    # Admin login
    admin_res = client.post("/api/auth/login", json={
        "email": "admin@example.com",
        "password": "admin123"
    })
    assert admin_res.status_code == 200
    admin_token = admin_res.json()["access_token"]
    assert admin_token is not None

    # Get admin clients (should see all 2 clients)
    clients_res = client.get(
        "/api/clients",
        headers={"Authorization": f"Bearer {admin_token}"}
    )
    assert clients_res.status_code == 200
    clients_data = clients_res.json()
    assert len(clients_data) >= 2

    # Client login (client1@example.com)
    c1_res = client.post("/api/auth/login", json={
        "email": "client1@example.com",
        "password": "client123"
    })
    assert c1_res.status_code == 200
    c1_token = c1_res.json()["access_token"]

    # Client querying clients should only see 1 (their own)
    c1_clients_res = client.get(
        "/api/clients",
        headers={"Authorization": f"Bearer {c1_token}"}
    )
    assert c1_clients_res.status_code == 200
    c1_clients_data = c1_clients_res.json()
    assert len(c1_clients_data) == 1
    assert c1_clients_data[0]["name"] == "Apex Retailers Pvt Ltd"

    # Client cannot create new clients (forbidden)
    forbidden_res = client.post(
        "/api/clients",
        headers={"Authorization": f"Bearer {c1_token}"},
        json={"name": "Illegal Client"}
    )
    assert forbidden_res.status_code == 403

def test_new_user_creation_and_login():
    # 1. Admin login
    admin_login = client.post("/api/auth/login", json={
        "email": "admin@example.com",
        "password": "admin123"
    })
    assert admin_login.status_code == 200
    admin_token = admin_login.json()["access_token"]

    # 2. Create a new user
    new_email = "new_reviewer@example.com"
    new_password = "reviewer_pass_456"
    create_res = client.post(
        "/api/users",
        headers={"Authorization": f"Bearer {admin_token}"},
        json={
            "email": new_email,
            "password": new_password,
            "full_name": "Pooja Sharma",
            "role": "staff"
        }
    )
    assert create_res.status_code in [201, 200]
    new_user_id = create_res.json()["id"]

    # 3. Verify newly created user can log in immediately
    new_login = client.post("/api/auth/login", json={
        "email": new_email,
        "password": new_password
    })
    assert new_login.status_code == 200
    new_user_token = new_login.json()["access_token"]
    assert new_user_token is not None

    # 4. Verify /auth/me returns the new user's profile
    me_res = client.get(
        "/api/auth/me",
        headers={"Authorization": f"Bearer {new_user_token}"}
    )
    assert me_res.status_code == 200
    me_data = me_res.json()
    assert me_data["email"] == new_email
    assert me_data["full_name"] == "Pooja Sharma"
    assert me_data["role"] == "staff"

    # 5. Clean up - delete user
    del_res = client.delete(
        f"/api/users/{new_user_id}",
        headers={"Authorization": f"Bearer {admin_token}"}
    )
    assert del_res.status_code in [204, 200]

import axios from 'axios';

// Hardcoded localhost, breaks in any multi-service deployment
const BASE = 'http://localhost:8080';

export async function fetchUserData(userId) {
  // No timeout, hangs if the upstream is slow
  const res = await axios.get(`${BASE}/users/${userId}`);
  return res.data;
}

export async function fetchInventory() {
  const res = await axios.get('http://localhost:8080/inventory');
  return res.data;
}

export async function postOrder(payload) {
  // No retry, a transient failure loses the order
  const res = await axios.post('http://localhost:8081/orders', payload);
  return res.data;
}

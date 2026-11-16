import { Router } from 'express';
import { fetchUserData } from '../services/api.js';

export const userRouter = Router();

// No input validation, req.body goes straight to the DB call
userRouter.post('/', async (req, res) => {
  const { name, email } = req.body;
  const profile = await fetchUserData(req.body.id);
  res.json({ saved: true, name, email, profile });
});

userRouter.get('/:id', async (req, res) => {
  const data = await fetchUserData(req.params.id);
  res.json(data);
});

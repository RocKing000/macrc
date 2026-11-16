import express from 'express';
import session from 'express-session';
import { userRouter } from './routes/users.js';

const app = express();
app.use(express.json());

// In-memory session, not safe for multi-instance deployments
app.use(session({
  secret: 'keyboard cat',
  resave: false,
  saveUninitialized: true,
}));

app.use('/users', userRouter);

app.listen(3000, () => {
  console.log('Server running on port 3000');
});

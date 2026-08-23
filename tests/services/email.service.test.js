const mockSendMail = jest.fn();

jest.mock('nodemailer', () => ({
  createTransport: jest.fn().mockImplementation(() => ({ sendMail: mockSendMail })),
}));

const emailService = require('../../src/services/email.service');

beforeEach(() => {
  mockSendMail.mockReset();
});

function fakeTask(overrides = {}) {
  return {
    id: 'task-1',
    title: 'Collect boxes',
    codeNumber: '260801',
    deadline: new Date('2026-08-31'),
    ...overrides,
  };
}
function fakeUser(overrides = {}) {
  return { name: 'Om Prakash', email: 'om@dawateislami.net', ...overrides };
}

describe('sendDeadlineSoonEmail', () => {
  it('sends to the given user with the task details in the subject/body', async () => {
    mockSendMail.mockResolvedValue({});
    const task = fakeTask();
    const user = fakeUser();

    const result = await emailService.sendDeadlineSoonEmail(task, user);

    expect(result).toBe(true);
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const call = mockSendMail.mock.calls[0][0];
    expect(call.to).toBe('om@dawateislami.net');
    expect(call.subject).toContain('Collect boxes');
    expect(call.subject).toContain('260801');
    expect(call.html).toContain('Collect boxes');
    expect(call.html).toContain('260801');
    expect(call.html).toContain('Deadline Approaching');
  });

  it('includes a link back into the app built from FRONTEND_URL', async () => {
    mockSendMail.mockResolvedValue({});
    await emailService.sendDeadlineSoonEmail(fakeTask(), fakeUser());
    const call = mockSendMail.mock.calls[0][0];
    expect(call.html).toContain('http://localhost:5173/tasks/task-1');
  });
});

describe('sendOverdueEmail', () => {
  it('sends with the overdue heading', async () => {
    mockSendMail.mockResolvedValue({});
    await emailService.sendOverdueEmail(fakeTask(), fakeUser());
    const call = mockSendMail.mock.calls[0][0];
    expect(call.subject).toContain('Overdue');
    expect(call.html).toContain('Task Overdue');
  });
});

describe('SMTP failure resilience', () => {
  it('catches a transporter error, logs it, and returns false rather than throwing', async () => {
    mockSendMail.mockRejectedValue(new Error('SMTP connection refused'));

    await expect(emailService.sendDeadlineSoonEmail(fakeTask(), fakeUser())).resolves.toBe(false);
  });
});
